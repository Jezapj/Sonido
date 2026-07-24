import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSerialStream } from "./useSerialStream";

const GUITAR_BUF = 1024;
const FS = 47991;

interface WaveformPeak {
  mn: number;
  mx: number;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function fmtTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

/** Pre-calculates downsampled min/max peaks ONCE when the file is decoded */
function getWaveformPeaks(buf: AudioBuffer, width: number): WaveformPeak[] {
  const data = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / width));
  const peaks: WaveformPeak[] = [];

  for (let x = 0; x < width; x++) {
    let mn = 0, mx = 0;
    const off = x * step;
    for (let j = 0; j < step && off + j < data.length; j++) {
      const s = data[off + j];
      if (s < mn) mn = s;
      if (s > mx) mx = s;
    }
    peaks.push({ mn, mx });
  }
  return peaks;
}

/** Paint the backing track waveform + playhead onto a canvas using cached peaks. Lightning fast. */
function paintBacking(canvas: HTMLCanvasElement, peaks: WaveformPeak[], progress: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const mid  = H / 2;
  const playedX = progress * W;

  // Horizontal centre line
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();

  // Waveform bars — played region brighter
  for (let x = 0; x < peaks.length; x++) {
    const { mn, mx } = peaks[x];
    ctx.strokeStyle = x < playedX
      ? "rgba(99,102,241,0.9)"
      : "rgba(99,102,241,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, mid + mn * mid * 0.85);
    ctx.lineTo(x + 0.5, mid + mx * mid * 0.85);
    ctx.stroke();
  }

  // Played-region tint
  if (playedX > 0) {
    ctx.fillStyle = "rgba(99,102,241,0.07)";
    ctx.fillRect(0, 0, playedX, H);
  }

  // Playhead
  if (progress > 0.001 && progress < 0.999) {
    ctx.strokeStyle = "#a5b4fc";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playedX, 0);
    ctx.lineTo(playedX, H);
    ctx.stroke();

    // Small diamond handle at top
    ctx.fillStyle = "#a5b4fc";
    ctx.beginPath();
    ctx.moveTo(playedX,     0);
    ctx.lineTo(playedX + 5, 6);
    ctx.lineTo(playedX,     12);
    ctx.lineTo(playedX - 5, 6);
    ctx.closePath();
    ctx.fill();
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RustStreamExample() {

  // ── Guitar waveform ────────────────────────────────────────────────────────
  const gCanvasRef = useRef<HTMLCanvasElement>(null);
  const gBufRef    = useRef(new Float32Array(GUITAR_BUF));
  const gAnimRef   = useRef(0);
  const liveRef    = useRef(false);

  const [chunks,  setChunks]  = useState(0);
  const [chunkSz, setChunkSz] = useState<number | null>(null);
  const [peak,    setPeak]    = useState<number | null>(null);

  // ── Shared Web Audio context ────────────────────────────────────────────────
  const actxRef  = useRef<AudioContext | null>(null);
  const gGainRef = useRef<GainNode | null>(null);   // guitar output gain
  const bGainRef = useRef<GainNode | null>(null);   // backing output gain
  const gNextRef = useRef(0);                        // guitar schedule head

  // ── Guitar monitor ─────────────────────────────────────────────────────────
  const [monOn, setMonOn] = useState(false);
  const monRef  = useRef(false);

  // ── Hardware DAC mute ──────────────────────────────────────────────────────
  const [hwMuted, setHwMuted] = useState(false);
  const [muteLoading, setMuteLoading] = useState(false);

  // ── Mix (0 = guitar only, 1 = backing only) ────────────────────────────────
  const [mix, setMix] = useState(0.5);
  const mixRef = useRef(0.5);

  // ── Backing track ──────────────────────────────────────────────────────────
  const bCanvasRef = useRef<HTMLCanvasElement>(null);
  const bABufRef   = useRef<AudioBuffer | null>(null);
  const bPeaksRef  = useRef<WaveformPeak[]>([]);      // Cached waveform visuals
  const lastSecRef = useRef<number>(-1);              // Used to throttle state re-renders
  const bSrcRef    = useRef<AudioBufferSourceNode | null>(null);
  const bStartRef  = useRef(0);      // actx.currentTime when src.start() was called
  const bOffRef    = useRef(0);      // resume offset in seconds
  const bLoopRef   = useRef(false);  // mutable loop flag used inside RAF + onended
  const bAnimRef   = useRef(0);
  const fileRef    = useRef<HTMLInputElement>(null);

  const [bName,  setBName]  = useState("");
  const [bDur,   setBDur]   = useState(0);
  const [bProg,  setBProg]  = useState(0);
  const [bPlay,  setBPlay]  = useState(false);
  const [bLoop,  setBLoop]  = useState(false);
  const [bLoad,  setBLoad]  = useState(false);

  // ── AudioContext bootstrap ─────────────────────────────────────────────────

  const ensureCtx = useCallback((): AudioContext => {
    if (actxRef.current && actxRef.current.state !== "closed") return actxRef.current;
    const ctx = new AudioContext({ sampleRate: FS });
    const gg = ctx.createGain();
    const bg = ctx.createGain();
    gg.gain.value = 1 - mixRef.current;
    bg.gain.value = mixRef.current;
    gg.connect(ctx.destination);
    bg.connect(ctx.destination);
    gGainRef.current = gg;
    bGainRef.current = bg;
    actxRef.current  = ctx;
    gNextRef.current = 0;
    return ctx;
  }, []);

  // Keep gain nodes in sync with mix slider
  useEffect(() => {
    mixRef.current = mix;
    if (gGainRef.current) gGainRef.current.gain.value = 1 - mix;
    if (bGainRef.current) bGainRef.current.gain.value = mix;
  }, [mix]);

  // Keep monitor ref in sync
  useEffect(() => {
    monRef.current = monOn;
    if (!monOn) gNextRef.current = 0;
  }, [monOn]);

  // ── Guitar monitor scheduling ──────────────────────────────────────────────

  const scheduleGuitarChunk = useCallback((samples: number[]) => {
    if (!monRef.current) return;
    const ctx = ensureCtx();
    if (ctx.state === "suspended") ctx.resume();
    const ab = ctx.createBuffer(1, samples.length, FS);
    ab.getChannelData(0).set(new Float32Array(samples));
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(gGainRef.current!);
    const now = ctx.currentTime;
    if (gNextRef.current > now + 0.3) gNextRef.current = now + 0.05;
    const at = Math.max(gNextRef.current, now + 0.02);
    src.start(at);
    gNextRef.current = at + ab.duration;
  }, [ensureCtx]);

  // ── Guitar waveform draw loop ──────────────────────────────────────────────

  const drawGuitar = useCallback(() => {
    const canvas = gCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 0.5;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(0, H * i / 4); ctx.lineTo(W, H * i / 4); ctx.stroke();
    }
    for (let i = 1; i < 8; i++) {
      ctx.beginPath(); ctx.moveTo(W * i / 8, 0); ctx.lineTo(W * i / 8, H); ctx.stroke();
    }

    const buf  = gBufRef.current;
    const step = W / GUITAR_BUF;
    const mid  = H / 2;
    ctx.beginPath();
    ctx.strokeStyle = "#AFA9EC";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    for (let i = 0; i < GUITAR_BUF; i++) {
      const x = i * step;
      const y = mid - buf[i] * mid * 0.85;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (liveRef.current) gAnimRef.current = requestAnimationFrame(drawGuitar);
  }, []);

  // ── Guitar chunk ingest ────────────────────────────────────────────────────

  const ingestGuitar = useCallback((samples: number[]) => {
    const len = samples.length;
    const buf  = gBufRef.current;
    if (len >= GUITAR_BUF) buf.set(samples.slice(len - GUITAR_BUF));
    else { buf.copyWithin(0, len); buf.set(samples, GUITAR_BUF - len); }
    let p = 0;
    for (const s of samples) { const a = Math.abs(s); if (a > p) p = a; }
    setChunks(n => n + 1);
    setChunkSz(len);
    setPeak(p);
    if (!liveRef.current) {
      liveRef.current = true;
      gAnimRef.current = requestAnimationFrame(drawGuitar);
    }
  }, [drawGuitar]);

  // ── Combined chunk handler (vis + optional monitor) ────────────────────────

  const onChunk = useCallback((samples: number[]) => {
    ingestGuitar(samples);
    scheduleGuitarChunk(samples);
  }, [ingestGuitar, scheduleGuitarChunk]);

  // ── Serial stream controls ─────────────────────────────────────────────────

  const {
    connected,
  } = useSerialStream(onChunk);

  const handleLocalReset = useCallback(() => {
    liveRef.current = false;
    cancelAnimationFrame(gAnimRef.current);
    gBufRef.current.fill(0);
    setMonOn(false);
    setChunks(0);
    setChunkSz(null);
    setPeak(null);
    if (hwMuted) {
      invoke<void>("set_output_mute", { muted: false }).catch(() => {});
      setHwMuted(false);
    }
  }, [hwMuted]);

  // When dashboard disconnects, reset local waveform state
  useEffect(() => {
    if (!connected) handleLocalReset();
  }, [connected, handleLocalReset]);

  const toggleHardwareMute = useCallback(async () => {
    const next = !hwMuted;
    setMuteLoading(true);
    try {
      await invoke<void>("set_output_mute", { muted: next });
      setHwMuted(next);
    } catch (e) {
      console.warn("[RustStreamExample] set_output_mute failed:", e);
    } finally {
      setMuteLoading(false);
    }
  }, [hwMuted]);

  // ── Backing track: file load ───────────────────────────────────────────────

  const loadAudioFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBLoad(true);
    try {
      const ctx = ensureCtx();
      if (ctx.state === "suspended") ctx.resume();
      const ab = await ctx.decodeAudioData(await file.arrayBuffer());

      // Halt any running playback
      if (bSrcRef.current) {
        try { bSrcRef.current.stop(); } catch { /**/ }
        bSrcRef.current = null;
      }
      cancelAnimationFrame(bAnimRef.current);

      bABufRef.current  = ab;
      bPeaksRef.current = getWaveformPeaks(ab, 680); // Generated once on load
      bOffRef.current   = 0;
      lastSecRef.current = -1;
      setBName(file.name);
      setBDur(ab.duration);
      setBProg(0);
      setBPlay(false);

      // Paint initial static waveform after the canvas has rendered
      setTimeout(() => {
        if (bCanvasRef.current && bPeaksRef.current.length > 0) {
          paintBacking(bCanvasRef.current, bPeaksRef.current, 0);
        }
      }, 60);
    } catch {
      alert("Could not decode audio. Accepted formats: WAV, MP3, OGG, FLAC, AAC.");
    }
    setBLoad(false);
    if (e.target) e.target.value = "";
  }, [ensureCtx]);

  // ── Backing track: stop ────────────────────────────────────────────────────

  const bStop = useCallback((reset = true) => {
    if (bSrcRef.current) {
      try { bSrcRef.current.stop(); } catch { /**/ }
      bSrcRef.current = null;
    }
    cancelAnimationFrame(bAnimRef.current);
    setBPlay(false);
    if (reset) {
      bOffRef.current = 0;
      lastSecRef.current = -1;
      setBProg(0);
      if (bCanvasRef.current && bPeaksRef.current.length > 0)
        paintBacking(bCanvasRef.current, bPeaksRef.current, 0);
    }
  }, []);

  // ── Backing track: start ───────────────────────────────────────────────────

  const bStart = useCallback((fromOffset?: number) => {
    const ab = bABufRef.current;
    if (!ab) return;
    const ctx = ensureCtx();
    if (ctx.state === "suspended") ctx.resume();
    if (!bGainRef.current) return;

    const off = fromOffset ?? bOffRef.current;
    bOffRef.current = off;

    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.loop   = bLoopRef.current;
    src.connect(bGainRef.current);
    src.start(0, off);
    bStartRef.current = ctx.currentTime;
    bSrcRef.current   = src;
    setBPlay(true);

    // Natural end handler (fires only for non-looping sources)
    src.onended = () => {
      if (bSrcRef.current !== src) return; // manually stopped — ignore
      if (bLoopRef.current) return;        // loop self-handles
      bSrcRef.current = null;
      cancelAnimationFrame(bAnimRef.current);
      bOffRef.current = 0;
      lastSecRef.current = -1;
      setBPlay(false);
      setBProg(0);
      if (bCanvasRef.current && bPeaksRef.current.length > 0)
        paintBacking(bCanvasRef.current, bPeaksRef.current, 0);
    };

    // Performance Optimized Progress animation loop
    const tick = () => {
      const ab2  = bABufRef.current;
      const ctx2 = actxRef.current;
      if (!ab2 || !ctx2 || !bSrcRef.current) return;
      const elapsed = ctx2.currentTime - bStartRef.current;
      let pos = off + elapsed;
      if (bLoopRef.current && ab2.duration > 0) pos = pos % ab2.duration;
      else pos = Math.min(pos, ab2.duration);
      const prog = ab2.duration > 0 ? pos / ab2.duration : 0;
      
      // 1. Instantly draw frame using precalculated peaks (60 FPS, completely independent of React context)
      if (bCanvasRef.current && bPeaksRef.current.length > 0) {
        paintBacking(bCanvasRef.current, bPeaksRef.current, prog);
      }
      
      // 2. Throttle state updates to occur only when the string clock second increments
      const currentSec = Math.floor(pos);
      if (currentSec !== lastSecRef.current) {
        lastSecRef.current = currentSec;
        setBProg(prog);
      }
      
      bAnimRef.current = requestAnimationFrame(tick);
    };
    bAnimRef.current = requestAnimationFrame(tick);
  }, [ensureCtx]);

  // ── Backing track: pause ───────────────────────────────────────────────────

  const bPause = useCallback(() => {
    const ctx = actxRef.current;
    const ab  = bABufRef.current;
    if (!ctx || !ab || !bSrcRef.current) return;
    const elapsed = ctx.currentTime - bStartRef.current;
    bOffRef.current = Math.min(bOffRef.current + elapsed, ab.duration);
    bStop(false);
  }, [bStop]);

  // ── Backing track: seek (click on waveform) ────────────────────────────────

  const bSeek = useCallback((prog: number) => {
    const ab = bABufRef.current;
    if (!ab) return;
    const wasPlaying = !!bSrcRef.current;
    if (wasPlaying) bStop(false);
    const newOff = Math.max(0, Math.min(prog * ab.duration, ab.duration));
    bOffRef.current = newOff;
    lastSecRef.current = Math.floor(newOff);
    setBProg(prog);
    if (bCanvasRef.current && bPeaksRef.current.length > 0) 
      paintBacking(bCanvasRef.current, bPeaksRef.current, prog);
    if (wasPlaying) bStart(newOff);
  }, [bStop, bStart]);

  // ── Backing track: toggle loop ─────────────────────────────────────────────

  const toggleBLoop = useCallback(() => {
    const next = !bLoopRef.current;
    bLoopRef.current = next;
    setBLoop(next);
    if (bSrcRef.current) bSrcRef.current.loop = next;
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────

  useEffect(() => () => {
    liveRef.current = false;
    cancelAnimationFrame(gAnimRef.current);
    cancelAnimationFrame(bAnimRef.current);
    if (bSrcRef.current) { try { bSrcRef.current.stop(); } catch { /**/ } }
    actxRef.current?.close();
  }, []);

  // ── Shared button base style ───────────────────────────────────────────────

  const btn: React.CSSProperties = {
    fontFamily: "monospace",
    fontSize: 11,
    cursor: "pointer",
    borderRadius: 7,
    padding: "4px 10px",
    border: "0.5px solid rgba(255,255,255,0.22)",
    background: "transparent",
    color: "#fff",
    transition: "background 0.15s, color 0.15s, border-color 0.15s",
    whiteSpace: "nowrap",
    lineHeight: "1.5",
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ fontFamily: "monospace", padding: "0.6rem 0.2rem " }}>

      {/* ── Status badge + monitor controls ──────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 5, alignItems: "center", gap: 8 }}>
        <span style={{
          fontSize: 11, padding: "1px 10px", borderRadius: 99,
          background: connected ? "rgba(83,74,183,0.25)" : "rgba(255,255,255,0.08)",
          color: connected ? "#AFA9EC" : "rgba(255,255,255,0.4)",
          display: "flex", alignItems: "center", gap: 5,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%",
            background: "currentColor",
            animation: connected ? "rse-pulse 1.1s infinite" : "none",
          }} />
          {connected ? "live" : "idle · connect in Dashboard"}
        </span>

        <button
          onClick={() => setMonOn(v => !v)}
          disabled={!connected}
          title={monOn
            ? "Stop playing audio through this device's speakers"
            : "Play both guitar + backing through this device's speakers"}
          style={{
            ...btn,
            opacity: connected ? 1 : 0.4,
            borderColor: monOn
              ? "rgba(175,169,236,0.65)"
              : "rgba(255,255,255,0.22)",
            color: monOn ? "#AFA9EC" : "rgba(255,255,255,0.5)",
            background: monOn ? "rgba(175,169,236,0.12)" : "transparent",
          }}
        >
          {monOn ? "👂 Monitor: ON" : "👂 Monitor: OFF"}
        </button>
        <button
          onClick={toggleHardwareMute}
          disabled={!connected || muteLoading}
          title={hwMuted
            ? "Restore hardware speaker output (ESP32 DAC)"
            : "Silence the hardware speaker output (ESP32 DAC)"}
          style={{
            ...btn,
            opacity: (!connected || muteLoading) ? 0.5 : 1,
            borderColor: hwMuted
              ? "rgba(239,68,68,0.7)"
              : "rgba(255,255,255,0.22)",
            color: hwMuted ? "#ef4444" : "rgba(255,255,255,0.5)",
            background: hwMuted ? "rgba(239,68,68,0.10)" : "transparent",
          }}
        >
          {hwMuted ? "🔇 HW: Muted" : "🔊 HW: Live"}
        </button>
      </div>

      {/* ── Guitar waveform canvas ─────────────────────────────────────────── */}
      <div style={{
        border: "0.5px solid rgba(255,255,255,0.12)",
        borderRadius: 10, overflow: "hidden", marginBottom: 1,
      }}>
        <canvas ref={gCanvasRef} width={680} height={70}
          style={{ display: "block", width: "100%", height: 70 }} />
      </div>

      {/* ── Stats row ─────────────────────────────────────────────────────── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3,1fr)",
        gap: 6, marginBottom: 8,
      }}>
        {[
          { label: "Samples/chunk", value: chunkSz ?? "—" },
          { label: "Peak amplitude", value: peak != null ? peak.toFixed(3) : "—" },
          { label: "Chunks recv'd",  value: chunks },
        ].map(({ label, value }) => (
          <div key={label} style={{ padding: "4px 8px", borderRadius: 7 }}>
            <div style={{
              fontSize: 9, color: "rgba(255,255,255,0.35)",
              textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 1,
            }}>
              {label}
            </div>
            <div style={{ fontSize: 15, fontWeight: 500, color: "#fff" }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* ── BACKING TRACK SECTION ──────────────────────────────────────────── */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      <div
        className="rse-backing-section"
        style={{
          borderTop: "0.5px solid rgba(255,255,255,0.07)",
          paddingTop: 2, marginBottom: 4,
        }}
      >

        {/* Header: label + filename + add button */}
        <div style={{
          display: "flex", alignItems: "center",
          justifyContent: "space-between", marginBottom: 2, gap: 8,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            <span style={{
              fontSize: 10, color: "rgba(255,255,255,0.28)",
              letterSpacing: "0.1em", textTransform: "uppercase", flexShrink: 0,
            }}>
              Backing Track
            </span>
            {bName && (
              <span style={{
                fontSize: 10,
                color: "rgba(99,102,241,0.65)",
                overflow: "hidden", textOverflow: "ellipsis",
                whiteSpace: "nowrap", maxWidth: 110,
              }} title={bName}>
                {bName}
              </span>
            )}
          </div>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={bLoad}
            style={{
              ...btn,
              borderColor: "rgba(99,102,241,0.45)",
              color: "#818cf8",
              opacity: bLoad ? 0.5 : 1,
              padding: "4px 13px",
              flexShrink: 0,
            }}
          >
            {bLoad ? "Loading…" : bDur > 0 ? "Change" : "+ Add Audio"}
          </button>
        </div>

        {/* ── Backing track body (only shown when a file is loaded) ────────── */}
        {bDur > 0 ? (
          <>
            {/* Waveform — click to seek */}
            <div
              style={{
                border: "0.5px solid rgba(99,102,241,0.28)",
                borderRadius: 8, overflow: "hidden",
                marginBottom: 3, cursor: "pointer",
                position: "relative",
              }}
              onClick={e => {
                const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                bSeek((e.clientX - r.left) / r.width);
              }}
              title="Click to seek"
            >
              <canvas ref={bCanvasRef} width={680} height={45}
                style={{ display: "block", width: "100%", height: 45 }} />
            </div>

            {/* Playback controls row */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
              <button
                onClick={() => bPlay ? bPause() : bStart()}
                style={{
                  ...btn,
                  padding: "5px 18px",
                  background: bPlay ? "rgba(99,102,241,0.2)" : "rgba(99,102,241,0.08)",
                  borderColor: "rgba(99,102,241,0.5)",
                  color: "#818cf8",
                  fontWeight: 600,
                }}
              >
                {bPlay ? "⏸ Pause" : "▶ Play"}
              </button>

              <button
                onClick={() => bStop(true)}
                title="Stop & reset"
                style={btn}
              >
                ⏹
              </button>

              <button
                onClick={toggleBLoop}
                title={bLoop ? "Disable loop" : "Enable loop"}
                style={{
                  ...btn,
                  background: bLoop ? "rgba(99,102,241,0.2)" : "transparent",
                  borderColor: bLoop
                    ? "rgba(99,102,241,0.55)"
                    : "rgba(255,255,255,0.18)",
                  color: bLoop ? "#818cf8" : "rgba(255,255,255,0.38)",
                }}
              >
                🔁
              </button>
              {/* Mix crossfader */}
            <div style={{
              background: "rgba(255,255,255,0.03)", width: "100%",
              borderRadius: 8, padding: "0px 10px", margin: "2px 10px -5px 10px",
            }}>
              <div style={{
                display: "flex", alignItems: "center",
                justifyContent: "space-between", marginBottom: 1,
              }}>
                <span style={{ fontSize: 9, color: "rgba(175,169,236,0.6)", letterSpacing: "0.08em" }}>
                  BACKING
                </span>
                <span style={{
                  fontSize: 10, color: "rgba(255,255,255,0.25)",
                  letterSpacing: "0.06em", fontVariantNumeric: "tabular-nums",
                }}>
                  MIX&nbsp;
                  <span style={{ color: "rgba(255,255,255,0.45)" }}>
                    {Math.round((1 - mix) * 100)}:{Math.round(mix * 100)}
                  </span>
                </span>
                <span style={{ fontSize: 9, color: "rgba(99,102,241,0.65)", letterSpacing: "0.08em" }}>
                  GUITAR
                </span>
              </div>
              <input
                type="range" min={0} max={1} step={0.01} value={mix}
                onChange={e => setMix(Number(e.target.value))}
                className="rse-mix-slider"
                style={{
                  width: "85%",
                  background: `linear-gradient(to right,
                    rgba(175,169,236,0.75) ${mix * 100}%,
                    rgba(99,102,241,0.55)  ${mix * 100}%)`,
                }}
              />
              <div style={{
                fontSize: 9.5, color: "rgba(255,255,255,0.17)",
                textAlign: "center", margin: "0px 0px -1px 0px", letterSpacing: "0.03em",
              }}>
                {monOn
                  ? "Mixing both streams through monitor speakers"
                  : "Enable monitor below to hear the mix through speakers"}
              </div>
            </div>

              {/* Time display */}
              <span style={{
                marginLeft: 0, fontSize: 11,
                color: "rgba(255,255,255,0.35)",
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "0.02em",
              }}>
                {fmtTime(bProg * bDur)}
                <span style={{ color: "rgba(255,255,255,0.18)", margin: "0 3px" }}>/</span>
                {fmtTime(bDur)}
              </span>
            </div>

            
          </>
        ) : (
          <div style={{
            fontSize: 11, color: "rgba(255,255,255,0.16)",
            textAlign: "center", padding: "2px 0",
            letterSpacing: "0.03em",
          }}>
            Load an audio file to use as a backing track
          </div>
        )}
      </div>

      {/* Hidden file input */}
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        style={{ display: "none" }}
        onChange={loadAudioFile}
      />

      {/* Global styles: pulse animation + mix slider thumb */}
      <style>{`
        @keyframes rse-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.3; }
        }
        .rse-mix-slider {
          -webkit-appearance: none;
          appearance: none;
          height: 0px;
          border-radius: 999px;
          outline: none;
          cursor: pointer;
          display: block;
        }
        .rse-mix-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 14px;
          height: 0px;
          border-radius: 50%;
          background: #a5b4fc;
          box-shadow: 0 0 7px rgba(99,102,241,0.65);
          cursor: pointer;
          border: 1.5px solid rgba(255,255,255,0.25);
          transition: transform 0.1s;
        }
        .rse-mix-slider::-webkit-slider-thumb:hover {
          transform: scale(1.2);
        }
        .rse-mix-slider::-moz-range-thumb {
          width: 14px;
          height: 0px;
          border-radius: 50%;
          background: #a5b4fc;
          border: 1.5px solid rgba(255,255,255,0.25);
          box-shadow: 0 0 7px rgba(99,102,241,0.65);
          cursor: pointer;
        }
      `}</style>
    </div>
  );
}