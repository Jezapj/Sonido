import { useRef, useState, useCallback } from "react";
import { useSerialStream } from "./useSerialStream";

const BUFFER_LEN  = 2048;
const SAMPLE_RATE = 47991;

// Pitch detection window — fundamentals only
const MIN_FREQ = 70;
const MAX_FREQ = 400;

// FFT display cutoff — shows harmonics up to this frequency.
// Guitar/bass fundamentals sit in ~80–1320 Hz; showing up to 4 kHz
// makes that range fill the canvas instead of squashing into the left edge.
const MAX_DISPLAY_HZ = 4000;

// ── FFT ──────────────────────────────────────────────────────────────────────
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

// ── Component ─────────────────────────────────────────────────────────────────
export default function DashboardAudio() {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const bufferRef   = useRef<Float32Array>(new Float32Array(BUFFER_LEN));
  const animRef     = useRef(0);
  const runningRef  = useRef(false);
  const prevFreqRef = useRef(0);
  const [note, setNote] = useState("—");

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

    // ── Pitch detection (full spectrum) ───────────────────────────────────
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

    // ── FFT display (limited to MAX_DISPLAY_HZ) ───────────────────────────
    // Hz per bin = SAMPLE_RATE / BUFFER_LEN  ≈ 23.4 Hz
    // Limiting to MAX_DISPLAY_HZ means the playable guitar/bass range
    // fills the full canvas width instead of sitting in a thin sliver.
    const displayBins = Math.min(
      mags.length,
      Math.ceil(MAX_DISPLAY_HZ * BUFFER_LEN / SAMPLE_RATE),
    );

    ctx.clearRect(0, 0, W, H);

    // Subtle frequency axis markers at 500 Hz intervals
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
    if (!runningRef.current) {
      runningRef.current = true;
      animRef.current = requestAnimationFrame(draw);
    }
  }, [ingestChunk, draw]);

  const { ports, selectedPort, setSelectedPort, connected, connect, disconnect, refreshPorts } =
    useSerialStream(onChunk);

  const handleDisconnect = () => {
    runningRef.current = false;
    cancelAnimationFrame(animRef.current);
    bufferRef.current.fill(0);
    disconnect();
  };

  return (
    <div style={{ position: "absolute", bottom: 15, left: 10, color: "white" }}>
      {!connected ? (
        <div style={{ paddingLeft: "3.5vw" }}>
          <h3>Not Connected</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <select
              value={selectedPort}
              onChange={e => setSelectedPort(e.target.value)}
              style={{
                background: "#1a1a2e", color: "#fff", border: "1px solid #444",
                borderRadius: 6, padding: "4px 8px", fontSize: 12, flex: 1,
              }}
            >
              {ports.length === 0
                ? <option value="">No ports found</option>
                : ports.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <button onClick={refreshPorts} title="Refresh ports" style={{
              background: "transparent", border: "1px solid #555", color: "#aaa",
              borderRadius: 6, padding: "4px 8px", cursor: "pointer", fontSize: 12,
            }}>↺</button>
          </div>
          <button onClick={connect} disabled={!selectedPort} style={{ opacity: selectedPort ? 1 : 0.4 }}>
            Connect
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "lime" }} />
            <h3>Connected — {selectedPort}</h3>
            <button onClick={handleDisconnect} style={{
              fontSize: 11, background: "transparent", border: "1px solid #555",
              color: "#aaa", borderRadius: 6, padding: "2px 8px", cursor: "pointer",
            }}>Disconnect</button>
          </div>
          <canvas ref={canvasRef} width={300} height={120} />
          <div style={{ marginTop: 10, fontSize: 30, fontWeight: "bold", color: "#AFA9EC" }}>
            {note}
          </div>
        </>
      )}
    </div>
  );
}