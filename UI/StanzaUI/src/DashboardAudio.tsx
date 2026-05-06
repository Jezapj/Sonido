import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

const BUFFER_LEN = 2048;
const SAMPLE_RATE = 48000; // change to 48000 if needed

const MIN_FREQ = 70;
const MAX_FREQ = 400;

// ---------------- FFT ----------------
function fft(re: Float32Array, im: Float32Array) {
  const N = re.length;

  for (let i = 0, j = 0; i < N; i++) {
    if (j > i) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
    let m = N >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = Math.PI * 2 / size;

    for (let i = 0; i < N; i += size) {
      for (let j = 0; j < half; j++) {
        const k = j * step;
        const cos = Math.cos(k);
        const sin = -Math.sin(k);

        const tpre = re[i + j + half] * cos - im[i + j + half] * sin;
        const tpim = re[i + j + half] * sin + im[i + j + half] * cos;

        re[i + j + half] = re[i + j] - tpre;
        im[i + j + half] = im[i + j] - tpim;
        re[i + j] += tpre;
        im[i + j] += tpim;
      }
    }
  }
}

// ---------------- HPS ----------------
function computeHPS(mags: Float32Array, harmonics = 5) {
  const len = mags.length;
  const hps = new Float32Array(len);
  hps.set(mags);

  for (let h = 2; h <= harmonics; h++) {
    for (let i = 0; i < len / h; i++) {
      hps[i] *= mags[i * h];
    }
  }

  let max = 0;
  let index = 0;

  for (let i = 10; i < len / harmonics; i++) {
    if (hps[i] > max) {
      max = hps[i];
      index = i;
    }
  }

  return { index, strength: max };
}

// ---------------- Autocorrelation ----------------
function autocorrelation(buf: Float32Array) {
  const SIZE = buf.length;
  let bestOffset = -1;
  let bestCorr = 0;

  for (let offset = 20; offset < SIZE / 2; offset++) {
    let corr = 0;

    for (let i = 0; i < SIZE / 2; i++) {
      corr += buf[i] * buf[i + offset];
    }

    if (corr > bestCorr) {
      bestCorr = corr;
      bestOffset = offset;
    }
  }

  if (bestOffset === -1) return { freq: 0, strength: 0 };

  return {
    freq: SAMPLE_RATE / bestOffset,
    strength: bestCorr
  };
}

// ---------------- Peak refinement ----------------
function refinePeak(mags: Float32Array, index: number) {
  if (index <= 0 || index >= mags.length - 1) return index;

  const a = mags[index - 1];
  const b = mags[index];
  const c = mags[index + 1];

  const denom = a - 2 * b + c;
  if (denom === 0) return index;

  return index + 0.5 * (a - c) / denom;
}

// ---------------- Subharmonic correction ----------------
function correctSubharmonic(freq: number, mags: Float32Array) {
  const bin = Math.round((freq * BUFFER_LEN) / SAMPLE_RATE);

  for (let d = 2; d <= 4; d++) {
    const subBin = Math.round(bin / d);

    if (subBin < 5) continue;

    if (mags[subBin] > mags[bin] * 0.5) {
      return freq / d;
    }
  }

  return freq;
}

// ---------------- Note conversion ----------------
function freqToNote(freq: number) {
  if (freq <= 0) return "—";

  const A4 = 440;
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  const n = Math.round(12 * Math.log2(freq / A4));
  const idx = (n + 9 + 1200) % 12;
  const octave = 4 + Math.floor((n + 9) / 12);

  return `${names[idx]}${octave}`;
}

// ---------------- Component ----------------
export default function DashboardAudio() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufferRef = useRef<Float32Array>(new Float32Array(BUFFER_LEN));

  const animRef = useRef(0);
  const runningRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const prevFreqRef = useRef(0);

  const [connected, setConnected] = useState(false);
  const [note, setNote] = useState("—");

  // ingest
  const ingestChunk = useCallback((samples: number[]) => {
    let energy = 0;
    for (let i = 0; i < samples.length; i++) {
      energy += samples[i] * samples[i];
    }
    energy /= samples.length;

    if (energy < 1e-6) return; // silence gate

    const buf = bufferRef.current;
    const len = samples.length;

    if (len >= BUFFER_LEN) {
      buf.set(samples.slice(len - BUFFER_LEN));
    } else {
      buf.copyWithin(0, len);
      buf.set(samples, BUFFER_LEN - len);
    }
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d")!;
    const W = canvas.width;
    const H = canvas.height;

    const re = new Float32Array(bufferRef.current);
    const im = new Float32Array(BUFFER_LEN);

    fft(re, im);

    const mags = new Float32Array(BUFFER_LEN / 2);
    for (let i = 0; i < mags.length; i++) {
      mags[i] = Math.sqrt(re[i] ** 2 + im[i] ** 2);
    }

    // HPS
    const { index: hpsIdx, strength } = computeHPS(mags);
    const refined = refinePeak(mags, hpsIdx);
    const freqHPS = (refined * SAMPLE_RATE) / BUFFER_LEN;

    // Autocorr
    const ac = autocorrelation(bufferRef.current);

    // Combine
    let freq = freqHPS;
    if (ac.strength > 0.2 && Math.abs(freqHPS - ac.freq) < 50) {
      freq = 0.5 * freqHPS + 0.5 * ac.freq;
    } else {
      freq = ac.freq;
    }

    // Subharmonic fix
    freq = correctSubharmonic(freq, mags);

    // Clamp range
    if (freq < MIN_FREQ || freq > MAX_FREQ) {
      freq = prevFreqRef.current;
    }

    // Confidence gate
    if (strength < 1e-4) {
      freq = 0;
    }

    // Smooth
    freq = prevFreqRef.current * 0.8 + freq * 0.2;
    prevFreqRef.current = freq;

    setNote(freqToNote(freq));

    // Draw FFT
    ctx.clearRect(0, 0, W, H);
    const barWidth = W / mags.length;

    for (let i = 0; i < mags.length; i++) {
      const h = (mags[i] / 50) * H;
      ctx.fillStyle = "#00ffcc";
      ctx.fillRect(i * barWidth, H - h, barWidth, h);
    }

    if (runningRef.current) {
      animRef.current = requestAnimationFrame(draw);
    }
  }, []);

  const start = async () => {
    bufferRef.current.fill(0);
    prevFreqRef.current = 0;

    runningRef.current = true;
    setConnected(true);

    cancelAnimationFrame(animRef.current);

    unlistenRef.current?.();
    unlistenRef.current = null;

    animRef.current = requestAnimationFrame(draw);

    await invoke("stream_audio"); //Change here to real stream ( stream_audio_serial )

    unlistenRef.current = await listen<number[]>("audio_chunk", (event) => {
      ingestChunk(event.payload);
    });
  };

  const stop = () => {
    runningRef.current = false;
    cancelAnimationFrame(animRef.current);

    unlistenRef.current?.();
    unlistenRef.current = null;

    bufferRef.current.fill(0);
  };

  useEffect(() => {
    return () => stop();
  }, []);

  return (
    <div style={{ position: "absolute", bottom: 15, left: 10, color: "white" }}>
      {!connected ? (
        <><div style={{paddingLeft: "3.5vw"}}>
          <h3>Not Connected</h3>
          <button onClick={start}>Connect</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "lime" }} />
            <h3>Connected</h3>
          </div>

          <canvas ref={canvasRef} width={"300vw"} height={120} />

          <div style={{ marginTop: 10, fontSize: 30, fontWeight: "bold", color: "#AFA9EC" }}>
            {note}
          </div>
        </>
      )}
    </div>
  );
}