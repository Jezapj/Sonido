import { useEffect, useRef, useState, useCallback } from "react";
import { useSerialStream } from "./useSerialStream";

const BUFFER_LEN = 1024;

export default function RustStreamExample() {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const bufferRef    = useRef<Float32Array>(new Float32Array(BUFFER_LEN));
  const animFrameRef = useRef<number>(0);
  const runningRef   = useRef(false);

  const [chunkCount, setChunkCount] = useState(0);
  const [chunkSize,  setChunkSize]  = useState<number | null>(null);
  const [peak,       setPeak]       = useState<number | null>(null);

  // ── canvas draw loop ──────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth   = 0.5;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(0, H*i/4); ctx.lineTo(W, H*i/4); ctx.stroke();
    }
    for (let i = 1; i < 8; i++) {
      ctx.beginPath(); ctx.moveTo(W*i/8, 0); ctx.lineTo(W*i/8, H); ctx.stroke();
    }

    ctx.beginPath();
    ctx.strokeStyle = "#AFA9EC";
    ctx.lineWidth   = 1.5;
    ctx.lineJoin    = "round";
    const buf  = bufferRef.current;
    const step = W / BUFFER_LEN;
    const mid  = H / 2;
    for (let i = 0; i < BUFFER_LEN; i++) {
      const x = i * step;
      const y = mid - buf[i] * (mid * 0.85);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (runningRef.current) animFrameRef.current = requestAnimationFrame(draw);
  }, []);

  // ── ingest chunk ──────────────────────────────────────────────────────────
  const ingestChunk = useCallback((samples: number[]) => {
    const len = samples.length;
    const buf = bufferRef.current;
    if (len >= BUFFER_LEN) buf.set(samples.slice(samples.length - BUFFER_LEN));
    else { buf.copyWithin(0, len); buf.set(samples, BUFFER_LEN - len); }

    let p = 0;
    for (const s of samples) { const a = Math.abs(s); if (a > p) p = a; }

    setChunkCount(n => n + 1);
    setChunkSize(len);
    setPeak(p);

    // Start draw loop on first real chunk if not already running.
    if (!runningRef.current) {
      runningRef.current = true;
      animFrameRef.current = requestAnimationFrame(draw);
    }
  }, [draw]);

  const { ports, selectedPort, setSelectedPort, connected, connect, disconnect, refreshPorts } =
    useSerialStream(ingestChunk);

  const handleStop = useCallback(() => {
    runningRef.current = false;
    cancelAnimationFrame(animFrameRef.current);
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    disconnect();
  }, [disconnect]);

  useEffect(() => () => { runningRef.current = false; cancelAnimationFrame(animFrameRef.current); }, []);

  return (
    <div style={{ fontFamily: "monospace", padding: "1.5rem 0" }}>

      {/* Status badge */}
      <div style={{ display: "flex", flexDirection: "row-reverse", alignItems: "baseline", justifyContent: "space-between", marginBottom: "1rem" }}>
        <span style={{
          fontSize: 11, padding: "3px 9px", borderRadius: 99,
          background: connected ? "rgba(83,74,183,0.25)" : "rgba(255,255,255,0.08)",
          color:      connected ? "#AFA9EC"               : "rgba(255,255,255,0.4)",
          display: "flex", alignItems: "center", gap: 5,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%", background: "currentColor",
            animation: connected ? "pulse 1.1s infinite" : "none",
          }} />
          {connected ? "live" : "idle"}
        </span>
      </div>

      {/* Waveform canvas */}
      <div style={{ border: "0.5px solid rgba(255,255,255,0.12)", borderRadius: 12, overflow: "hidden" }}>
        <canvas ref={canvasRef} width={680} height={160}
          style={{ display: "block", width: "100%", height: 160 }} />
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginTop: 12 }}>
        {[
          { label: "Samples / chunk", value: chunkSize ?? "—" },
          { label: "Peak amplitude",  value: peak != null ? peak.toFixed(3) : "—" },
          { label: "Chunks received", value: chunkCount },
        ].map(({ label, value }) => (
          <div key={label} style={{ borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 500, color: "#ffffff" }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Port selector + connect/stop */}
      {!connected ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 14 }}>
          <select
            value={selectedPort}
            onChange={e => setSelectedPort(e.target.value)}
            style={{
              background: "#1a1a2e", color: "#fff", border: "0.5px solid rgba(255,255,255,0.25)",
              borderRadius: 8, padding: "6px 10px", fontSize: 12, fontFamily: "monospace",
            }}
          >
            {ports.length === 0
              ? <option value="">No ports found</option>
              : ports.map(p => <option key={p} value={p}>{p}</option>)
            }
          </select>
          <button
            onClick={refreshPorts}
            title="Refresh"
            style={{ padding: "6px 10px", fontSize: 12, fontFamily: "monospace", cursor: "pointer",
              borderRadius: 8, background: "transparent", border: "0.5px solid rgba(255,255,255,0.25)", color: "#ffffff" }}
          >↺</button>
          <button
            onClick={connect}
            disabled={!selectedPort}
            style={{ padding: "7px 18px", fontSize: 12, fontFamily: "monospace", cursor: "pointer",
              borderRadius: 8, background: "transparent", border: "0.5px solid rgba(255,255,255,0.25)",
              color: "#ffffff", opacity: selectedPort ? 1 : 0.4 }}
          >Start stream</button>
        </div>
      ) : (
        <button
          onClick={handleStop}
          style={{ marginTop: 14, padding: "7px 18px", fontSize: 12, fontFamily: "monospace",
            cursor: "pointer", borderRadius: 8, background: "transparent",
            border: "0.5px solid rgba(255,255,255,0.25)", color: "#ffffff" }}
        >Stop stream</button>
      )}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    </div>
  );
}