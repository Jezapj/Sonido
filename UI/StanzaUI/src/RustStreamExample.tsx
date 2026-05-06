import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

const BUFFER_LEN = 1024;

export default function RustStreamExample() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufferRef = useRef<Float32Array>(new Float32Array(BUFFER_LEN));
  const runningRef = useRef(false);
  const animFrameRef = useRef<number>(0);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  const [active, setActive] = useState(false);
  const [chunkCount, setChunkCount] = useState(0);
  const [chunkSize, setChunkSize] = useState<number | null>(null);
  const [peak, setPeak] = useState<number | null>(null);

  // ── ingest a chunk of f32 samples from Rust ──────────────────────────────
  const ingestChunk = useCallback((samples: number[]) => {
    const len = samples.length;
    const buf = bufferRef.current;

    if (len >= BUFFER_LEN) {
      buf.set(samples.slice(samples.length - BUFFER_LEN));
    } else {
      buf.copyWithin(0, len);
      buf.set(samples, BUFFER_LEN - len);
    }

    let p = 0;
    for (let i = 0; i < len; i++) {
      const abs = Math.abs(samples[i]);
      if (abs > p) p = abs;
    }

    setChunkCount((n) => n + 1);
    setChunkSize(len);
    setPeak(p);
  }, []);

  // ── canvas draw loop ──────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width;
    const H = canvas.height;

    // background
    ctx.clearRect(0, 0, W, H);

    // grid
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 0.5;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(0, H * i / 4); ctx.lineTo(W, H * i / 4); ctx.stroke();
    }
    for (let i = 1; i < 8; i++) {
      ctx.beginPath(); ctx.moveTo(W * i / 8, 0); ctx.lineTo(W * i / 8, H); ctx.stroke();
    }

    // waveform
    ctx.beginPath();
    ctx.strokeStyle = "#AFA9EC";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    const buf = bufferRef.current;
    const step = W / BUFFER_LEN;
    const mid = H / 2;
    for (let i = 0; i < BUFFER_LEN; i++) {
      const x = i * step;
      const y = mid - buf[i] * (mid * 0.85);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (runningRef.current) {
      animFrameRef.current = requestAnimationFrame(draw);
    }
  }, []);

  // ── start / stop ──────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    runningRef.current = true;
    setActive(true);
    animFrameRef.current = requestAnimationFrame(draw);

    // Tell Rust to begin emitting audio_chunk events
    await invoke("stream_audio");  //Change here to real stream ( stream_audio_serial )

    // event name matches app.emit("audio_chunk", ...) in Rust
    unlistenRef.current = await listen<number[]>("audio_chunk", (event) => {
      ingestChunk(event.payload);
    });
  }, [draw, ingestChunk]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setActive(false);
    cancelAnimationFrame(animFrameRef.current);
    unlistenRef.current?.();
    unlistenRef.current = null;

    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  // cleanup on unmount
  useEffect(() => () => stop(), [stop]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  return (
    <div style={{ fontFamily: "monospace", padding: "1.5rem 0" }}>
      {/* header */}
      <div style={{ display: "flex", flexDirection: "row-reverse", alignItems: "baseline", justifyContent: "space-between", marginBottom: "1rem" }}>
        {/* <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)" }}>
          Audio stream
        </span> */}
        <span style={{
          fontSize: 11, padding: "3px 9px", borderRadius: 99,
          background: active ? "rgba(83,74,183,0.25)" : "rgba(255,255,255,0.08)",
          color: active ? "#AFA9EC" : "rgba(255,255,255,0.4)",
          display: "flex", alignItems: "center", gap: 5,
        }}>
          <span style={{ width: 6, float: "right", height: 6, borderRadius: "50%", background: "currentColor", animation: active ? "pulse 1.1s infinite" : "none" }} />
          {active ? "live" : "idle"}
        </span>
      </div>

      {/* canvas */}
      <div style={{ border: "0.5px solid rgba(255,255,255,0.12)", borderRadius: 12, overflow: "hidden" }}>
        <canvas ref={canvasRef} width={680} height={160} style={{ display: "block", width: "100%", height: 160 }} />
      </div>

      {/* stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginTop: 12 }}>
        {[
          { label: "Samples / chunk", value: chunkSize ?? "—" },
          { label: "Peak amplitude",  value: peak != null ? peak.toFixed(3) : "—" },
          { label: "Chunks received", value: chunkCount },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: "transparent", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 500, color: "#ffffff" }}>{value}</div>
          </div>
        ))}
      </div>

      {/* toggle */}
      <button
        onClick={active ? stop : start}
        style={{ marginTop: 14, padding: "7px 18px", fontSize: 12, fontFamily: "monospace", letterSpacing: "0.05em", cursor: "pointer", borderRadius: 8, background: "transparent", border: "0.5px solid rgba(255,255,255,0.25)", color: "#ffffff" }}
      >
        {active ? "Stop stream" : "Start stream"}
      </button>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    </div>
  );
}