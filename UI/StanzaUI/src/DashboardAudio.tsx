import { useRef, useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSerialStream } from "./useSerialStream";
import { useIsLightMode } from "./UseTheme";
import DashboardMetronome from "./DashboardMetronome";
import DashboardChordBank from "./DashboardChordBank";

const BUFFER_LEN  = 4096;
const SAMPLE_RATE = 47991;

const MIN_FREQ = 70;
const MAX_FREQ = 400;
const MAX_DISPLAY_HZ = 4000;

const PANEL_COUNT = 3;
const PANEL_W = 300;
const SWIPE_THRESHOLD = 48;

const PANEL_LABELS = ["FFT", "METRO", "SONGS"];

// ── FFT helpers ───────────────────────────────────────────────────────────────
function fft(re: Float32Array, im: Float32Array) {
  const N = re.length;
  for (let i = 0, j = 0; i < N; i++) {
    if (j > i) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
    let m = N >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = Math.PI * 2 / size;
    for (let i = 0; i < N; i += size) {
      for (let j = 0; j < half; j++) {
        const k    = j * step;
        const cos  = Math.cos(k), sin = -Math.sin(k);
        const tpre = re[i+j+half]*cos - im[i+j+half]*sin;
        const tpim = re[i+j+half]*sin + im[i+j+half]*cos;
        re[i+j+half] = re[i+j] - tpre; im[i+j+half] = im[i+j] - tpim;
        re[i+j] += tpre; im[i+j] += tpim;
      }
    }
  }
}

function computeHPS(mags: Float32Array, harmonics = 5) {
  const len = mags.length;
  const hps = new Float32Array(len);
  hps.set(mags);
  for (let h = 2; h <= harmonics; h++)
    for (let i = 0; i < len / h; i++) hps[i] *= mags[i * h];
  let max = 0, index = 0;
  for (let i = 10; i < len / harmonics; i++) if (hps[i] > max) { max = hps[i]; index = i; }
  return { index, strength: max };
}

function autocorrelation(buf: Float32Array) {
  const SIZE = buf.length;
  let bestOffset = -1, bestCorr = 0;
  for (let offset = 20; offset < SIZE / 2; offset++) {
    let corr = 0;
    for (let i = 0; i < SIZE / 2; i++) corr += buf[i] * buf[i + offset];
    if (corr > bestCorr) { bestCorr = corr; bestOffset = offset; }
  }
  if (bestOffset === -1) return { freq: 0, strength: 0 };
  return { freq: SAMPLE_RATE / bestOffset, strength: bestCorr };
}

function refinePeak(mags: Float32Array, index: number) {
  if (index <= 0 || index >= mags.length - 1) return index;
  const a = mags[index-1], b = mags[index], c = mags[index+1];
  const denom = a - 2*b + c;
  return denom === 0 ? index : index + 0.5*(a-c)/denom;
}

function correctSubharmonic(freq: number, mags: Float32Array) {
  const bin = Math.round((freq * BUFFER_LEN) / SAMPLE_RATE);
  for (let d = 2; d <= 4; d++) {
    const subBin = Math.round(bin / d);
    if (subBin < 5) continue;
    if (mags[subBin] > mags[bin] * 0.5) return freq / d;
  }
  return freq;
}

function freqToNote(freq: number) {
  if (freq <= 0) return "—";
  const A4 = 440;
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const n = Math.round(12 * Math.log2(freq / A4));
  const idx = (n + 9 + 1200) % 12;
  const octave = 4 + Math.floor((n + 9) / 12);
  return `${names[idx]}${octave}`;
}

const btnBaseDark: React.CSSProperties = {
  background: "transparent",
  border: "0.5px solid rgba(255,255,255,0.25)",
  color: "#ffffff",
  borderRadius: 8,
  padding: "4px 10px",
  fontSize: 11,
  fontFamily: "monospace",
  cursor: "pointer",
  letterSpacing: "0.04em",
  transition: "background 0.15s, border-color 0.15s, color 0.15s",
  whiteSpace: "nowrap" as const,
};

const btnBaseLight: React.CSSProperties = {
  ...btnBaseDark,
  border: "0.5px solid rgba(0,0,0,0.22)",
  color: "#1a0f2e",
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function DashboardAudio() {
  const light = useIsLightMode();
  const btnBase = light ? btnBaseLight : btnBaseDark;
  const accent = light ? "#6d28d9" : "#AFA9EC";
  const muted = light ? "rgba(26,15,46,0.45)" : "rgba(255,255,255,0.45)";
  const rootColor = light ? "#1a0f2e" : "white";

  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const bufferRef   = useRef<Float32Array>(new Float32Array(BUFFER_LEN));
  const animRef     = useRef(0);
  const runningRef  = useRef(false);
  const prevFreqRef = useRef(0);
  const [note, setNote] = useState("—");

  const [isMonitoring, setIsMonitoring] = useState(false);
  const isMonitoringRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);

  const [isMuted, setIsMuted] = useState(false);
  const [muteLoading, setMuteLoading] = useState(false);

  // ── Carousel ───────────────────────────────────────────────────────────────
  const [page, setPage] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartX = useRef(0);
  const dragStartPage = useRef(0);
  const pageRef = useRef(0);

  useEffect(() => { pageRef.current = page; }, [page]);

  useEffect(() => {
    isMonitoringRef.current = isMonitoring;
    if (!isMonitoring) {
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      nextStartTimeRef.current = 0;
    }
  }, [isMonitoring]);

  useEffect(() => {
    return () => {
      audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  const scheduleAudioChunk = useCallback((samples: number[]) => {
    if (!isMonitoringRef.current) return;

    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      try {
        audioCtxRef.current = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
        nextStartTimeRef.current = 0;
      } catch {
        return;
      }
    }

    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const floats = new Float32Array(samples);
    const buf = ctx.createBuffer(1, floats.length, SAMPLE_RATE);
    buf.getChannelData(0).set(floats);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    const LOOKAHEAD = 0.005;
    const MAX_DRIFT = 0.030;

    if (nextStartTimeRef.current < now || nextStartTimeRef.current > now + MAX_DRIFT) {
      nextStartTimeRef.current = now + LOOKAHEAD;
    }

    const startAt = nextStartTimeRef.current;
    src.start(startAt);
    nextStartTimeRef.current = startAt + buf.duration;
  }, []);

  const toggleHardwareMute = useCallback(async () => {
    const next = !isMuted;
    setMuteLoading(true);
    try {
      await invoke<void>("set_output_mute", { muted: next });
      setIsMuted(next);
    } catch (e) {
      console.warn("[DashboardAudio] set_output_mute failed:", e);
    } finally {
      setMuteLoading(false);
    }
  }, [isMuted]);

  const ingestChunk = useCallback((samples: number[]) => {
    let energy = 0;
    for (const s of samples) energy += s * s;
    if (energy / samples.length < 1e-6) return;
    const buf = bufferRef.current;
    const len = samples.length;
    if (len >= BUFFER_LEN) buf.set(samples.slice(len - BUFFER_LEN));
    else { buf.copyWithin(0, len); buf.set(samples, BUFFER_LEN - len); }
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height;

    const re = new Float32Array(bufferRef.current);
    const im = new Float32Array(BUFFER_LEN);
    fft(re, im);

    const mags = new Float32Array(BUFFER_LEN / 2);
    for (let i = 0; i < mags.length; i++) mags[i] = Math.sqrt(re[i]**2 + im[i]**2);

    const { index: hpsIdx, strength } = computeHPS(mags);
    const refined = refinePeak(mags, hpsIdx);
    const freqHPS = (refined * SAMPLE_RATE) / BUFFER_LEN;
    const ac = autocorrelation(bufferRef.current);

    let freq = (ac.strength > 0.2 && Math.abs(freqHPS - ac.freq) < 50)
      ? 0.5 * freqHPS + 0.5 * ac.freq
      : ac.freq;
    freq = correctSubharmonic(freq, mags);
    if (freq < MIN_FREQ || freq > MAX_FREQ) freq = prevFreqRef.current;
    if (strength < 1e-4) freq = 0;
    freq = prevFreqRef.current * 0.8 + freq * 0.2;
    prevFreqRef.current = freq;
    setNote(freqToNote(freq));

    const displayBins = Math.min(
      mags.length,
      Math.ceil(MAX_DISPLAY_HZ * BUFFER_LEN / SAMPLE_RATE),
    );

    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 0.5;
    for (let hz = 500; hz < MAX_DISPLAY_HZ; hz += 500) {
      const x = (hz / MAX_DISPLAY_HZ) * W;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }

    const barWidth = W / displayBins;
    for (let i = 0; i < displayBins; i++) {
      const h = (mags[i] / 50) * H;
      ctx.fillStyle = "#00ffcc";
      ctx.fillRect(i * barWidth, H - h, barWidth, h);
    }

    if (runningRef.current) animRef.current = requestAnimationFrame(draw);
  }, []);

  const onChunk = useCallback((samples: number[]) => {
    ingestChunk(samples);
    scheduleAudioChunk(samples);
    if (!runningRef.current) {
      runningRef.current = true;
      animRef.current = requestAnimationFrame(draw);
    }
  }, [ingestChunk, scheduleAudioChunk, draw]);

  const { ports, selectedPort, setSelectedPort, connected, connect, disconnect, refreshPorts } =
    useSerialStream(onChunk);

  const handleDisconnect = () => {
    runningRef.current = false;
    cancelAnimationFrame(animRef.current);
    bufferRef.current.fill(0);
    setIsMonitoring(false);
    if (isMuted) {
      invoke<void>("set_output_mute", { muted: false }).catch(() => {});
      setIsMuted(false);
    }
    disconnect();
  };

  // ── Carousel swipe (loops) ─────────────────────────────────────────────────
  const wrapPage = (p: number) => ((p % PANEL_COUNT) + PANEL_COUNT) % PANEL_COUNT;

  const onPointerDown = (e: React.PointerEvent) => {
    // Don't steal drags from sliders / buttons
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStartX.current = e.clientX;
    dragStartPage.current = pageRef.current;
    setDragging(true);
    setDragX(0);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragX(e.clientX - dragStartX.current);
  };

  const finishDrag = (clientX: number) => {
    if (!dragging) return;
    const dx = clientX - dragStartX.current;
    let next = dragStartPage.current;
    if (dx <= -SWIPE_THRESHOLD) next = dragStartPage.current + 1;
    else if (dx >= SWIPE_THRESHOLD) next = dragStartPage.current - 1;
    setPage(wrapPage(next));
    setDragX(0);
    setDragging(false);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    finishDrag(e.clientX);
  };

  const goPage = (dir: -1 | 1) => {
    setPage(p => wrapPage(p + dir));
  };

  const trackOffset = -page * PANEL_W + (dragging ? dragX : 0);

  return (
    <div className="da-root" style={{ position: "absolute", bottom: 0, left: 10, color: rootColor }}>
      {!connected ? (
        <div style={{ width: PANEL_W, marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <select
              value={selectedPort}
              onChange={e => setSelectedPort(e.target.value)}
              style={{
                background: light ? "rgba(0,0,0,0.04)" : "#1a1a2e",
                color: rootColor,
                border: light ? "1px solid rgba(0,0,0,0.2)" : "1px solid #444",
                borderRadius: 6, padding: "4px 8px", fontSize: 12, flex: 1,
              }}
            >
              {ports.length === 0
                ? <option value="">No ports found</option>
                : ports.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <button onClick={refreshPorts} title="Refresh ports" style={{
              background: "transparent",
              border: light ? "1px solid rgba(0,0,0,0.25)" : "1px solid #555",
              color: light ? "rgba(26,15,46,0.55)" : "#aaa",
              borderRadius: 6, padding: "4px 8px", cursor: "pointer", fontSize: 12,
            }}>↺</button>
            <button
              onClick={connect}
              disabled={!selectedPort}
              style={{ ...btnBase, opacity: selectedPort ? 1 : 0.4, padding: "4px 10px" }}
            >
              Connect
            </button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "lime", flexShrink: 0 }} />
            <h4 style={{ margin: 0, fontSize: 13, color: rootColor }}>Connected: {selectedPort}</h4>
            <button
              onClick={handleDisconnect}
              style={{ ...btnBase, fontSize: 11, padding: "2px 8px" }}
            >
              Disconnect
            </button>
          </div>

          <div style={{ display: "flex", gap: 6, marginTop: 8, marginBottom: 4 }}>
            <button
              onClick={() => setIsMonitoring(v => !v)}
              title={isMonitoring
                ? "Stop playing audio through this device"
                : "Play incoming audio through this device's speakers"}
              style={{
                ...btnBase,
                borderColor: isMonitoring
                  ? (light ? "rgba(109,40,217,0.55)" : "rgba(175,169,236,0.7)")
                  : (light ? "rgba(0,0,0,0.22)" : "rgba(255,255,255,0.25)"),
                color: isMonitoring
                  ? accent
                  : (light ? "rgba(26,15,46,0.55)" : "rgba(255,255,255,0.55)"),
                background: isMonitoring
                  ? (light ? "rgba(109,40,217,0.1)" : "rgba(175,169,236,0.12)")
                  : "transparent",
              }}
            >
              {isMonitoring ? "Monitor: ON" : "Monitor: OFF"}
            </button>

            <button
              onClick={toggleHardwareMute}
              disabled={muteLoading}
              title={isMuted
                ? "Restore hardware speaker output"
                : "Silence the hardware speaker output (ESP32 DAC)"}
              style={{
                ...btnBase,
                opacity: muteLoading ? 0.5 : 1,
                borderColor: isMuted
                  ? "rgba(239,68,68,0.7)"
                  : (light ? "rgba(0,0,0,0.22)" : "rgba(255,255,255,0.25)"),
                color: isMuted ? "#ef4444" : (light ? "rgba(26,15,46,0.55)" : "rgba(255,255,255,0.55)"),
                background: isMuted ? "rgba(239,68,68,0.10)" : "transparent",
              }}
            >
              {isMuted ? "HW: Muted" : "HW: Live"}
            </button>
          </div>
        </>
      )}

      {/* Carousel — available with or without serial */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        width: PANEL_W, marginBottom: 4, marginTop: connected ? 0 : 2,
      }}>
        <button type="button" onClick={() => goPage(-1)} style={{ ...btnBase, padding: "2px 8px" }}>‹</button>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="da-label" style={{
            fontFamily: "monospace", fontSize: 10, letterSpacing: "0.12em",
            color: muted,
          }}>
            {PANEL_LABELS[page]}
          </span>
          <div style={{ display: "flex", gap: 5 }}>
            {PANEL_LABELS.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPage(i)}
                aria-label={`Go to ${PANEL_LABELS[i]}`}
                style={{
                  width: 6, height: 6, borderRadius: "50%", padding: 0, border: "none",
                  cursor: "pointer",
                  background: i === page ? accent : (light ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.25)"),
                  boxShadow: i === page ? `0 0 6px ${accent}` : "none",
                }}
              />
            ))}
          </div>
        </div>
        <button type="button" onClick={() => goPage(1)} style={{ ...btnBase, padding: "2px 8px" }}>›</button>
      </div>

      <div
        className="da-carousel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          width: PANEL_W,
          overflow: "hidden",
          touchAction: "pan-y",
          cursor: dragging ? "grabbing" : "grab",
        }}
      >
        <div
          style={{
            display: "flex",
            width: PANEL_W * PANEL_COUNT,
            transform: `translateX(${trackOffset}px)`,
            transition: dragging ? "none" : "transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          <div style={{ width: PANEL_W, flexShrink: 0 }}>
            <canvas ref={canvasRef} width={300} height={120} className="da-fft-canvas" />
            <div className="da-accent" style={{ marginTop: 10, fontSize: 30, fontWeight: "bold", color: accent }}>
              {note}
            </div>
          </div>

          <div style={{ width: PANEL_W, flexShrink: 0 }}>
            <DashboardMetronome />
          </div>

          <div style={{ width: PANEL_W, flexShrink: 0 }}>
            <DashboardChordBank />
          </div>
        </div>
      </div>
    </div>
  );
}
