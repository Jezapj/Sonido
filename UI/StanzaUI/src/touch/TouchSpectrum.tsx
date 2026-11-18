/**
 * The dashboard's FFT view, redrawn to fill the touch screen. Same transform,
 * range and options as the FFT panel in DashboardAudio.tsx.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fft } from "../DashboardAudio";
import { useSerialStream } from "../useSerialStream";
import { useIsLightMode } from "../UseTheme";
import { getLastNote, SAMPLE_RATE } from "../pitchTracker";
import { midiToName } from "../music";
import { Segmented } from "./controls";

const BUFFER_LEN = 4096;
const MAX_DISPLAY_HZ = 4000;

type Res = "low" | "normal" | "high";
type Pace = "fast" | "normal" | "slow";

/** Bars shown; high keeps one per FFT bin. */
const RES_BARS: Record<Res, number | null> = { low: 24, normal: 72, high: null };
/** How quickly a bar chases the new level. */
const PACE_ALPHA: Record<Pace, number> = { fast: 1, normal: 0.22, slow: 0.07 };

const RES_OPTIONS: { id: Res; label: string }[] = [
  { id: "low", label: "LOW" }, { id: "normal", label: "NORMAL" }, { id: "high", label: "HIGH" },
];
const PACE_OPTIONS: { id: Pace; label: string }[] = [
  { id: "fast", label: "FAST" }, { id: "normal", label: "NORMAL" }, { id: "slow", label: "SLOW" },
];

export default function TouchSpectrum({ active }: { active: boolean }) {
  const light = useIsLightMode();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufferRef = useRef(new Float32Array(BUFFER_LEN));
  const shownRef = useRef(new Float32Array(0));
  const [note, setNote] = useState("—");
  const [res, setRes] = useState<Res>("normal");
  const [pace, setPace] = useState<Pace>("normal");
  const optsRef = useRef({ res, pace, light });
  optsRef.current = { res, pace, light };

  const onChunk = useCallback((samples: number[]) => {
    let energy = 0;
    for (const s of samples) energy += s * s;
    if (energy / samples.length < 1e-6) return;
    const buf = bufferRef.current;
    const len = samples.length;
    if (len >= BUFFER_LEN) buf.set(samples.slice(len - BUFFER_LEN));
    else { buf.copyWithin(0, len); buf.set(samples, BUFFER_LEN - len); }
  }, []);

  const { connected } = useSerialStream(onChunk);

  useEffect(() => {
    if (connected) return;
    bufferRef.current.fill(0);
    shownRef.current = new Float32Array(0);
    setNote("—");
  }, [connected]);

  useEffect(() => {
    if (!active) return;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (!W || !H) return;
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const o = optsRef.current;
      const re = new Float32Array(bufferRef.current);
      const im = new Float32Array(BUFFER_LEN);
      fft(re, im);

      const displayBins = Math.min(BUFFER_LEN / 2, Math.ceil(MAX_DISPLAY_HZ * BUFFER_LEN / SAMPLE_RATE));
      const cap = RES_BARS[o.res];
      const bars = cap == null ? displayBins : Math.min(displayBins, cap);
      const alpha = PACE_ALPHA[o.pace];

      let shown = shownRef.current;
      if (shown.length !== bars) { shown = new Float32Array(bars); shownRef.current = shown; }
      for (let b = 0; b < bars; b++) {
        const start = Math.floor(b * displayBins / bars);
        const end = Math.max(start + 1, Math.floor((b + 1) * displayBins / bars));
        let sum = 0;
        for (let i = start; i < end; i++) sum += Math.sqrt(re[i] ** 2 + im[i] ** 2);
        shown[b] += alpha * (sum / (end - start) - shown[b]);
      }

      // Frequency grid, labelled along the bottom
      const axis = Math.max(14, H * 0.09);
      const plotH = H - axis;
      ctx.font = `600 ${Math.round(axis * 0.62)}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      for (let hz = 500; hz < MAX_DISPLAY_HZ; hz += 500) {
        const x = (hz / MAX_DISPLAY_HZ) * W;
        ctx.strokeStyle = o.light ? "rgba(26,15,46,0.1)" : "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke();
        if (hz % 1000 === 0) {
          ctx.fillStyle = o.light ? "rgba(26,15,46,0.5)" : "rgba(255,255,255,0.42)";
          ctx.fillText(`${hz / 1000}k`, x, H - 1);
        }
      }

      const barW = W / bars;
      const gap = cap == null ? 0 : Math.min(2, barW * 0.2);
      ctx.fillStyle = o.light ? "#0d9488" : "#00ffcc";
      for (let i = 0; i < bars; i++) {
        const h = Math.min(plotH, (shown[i] / 50) * plotH);
        ctx.fillRect(i * barW, plotH - h, Math.max(barW - gap, 1), h);
      }

      const last = getLastNote();
      setNote(last ? midiToName(last.midi) : "—");
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div className="ts-spectrum">
      <div className="ts-spectrum__plot">
        <canvas ref={canvasRef} />
        <div className="ts-spectrum__note" aria-label="Last note heard">{connected ? note : "—"}</div>
      </div>
      <div className="ts-spectrum__opts">
        <div className="ts-spectrum__opt">
          <span>RESOLUTION</span>
          <Segmented label="Resolution" options={RES_OPTIONS} value={res} onChange={setRes} />
        </div>
        <div className="ts-spectrum__opt">
          <span>RESPONSE</span>
          <Segmented label="Response" options={PACE_OPTIONS} value={pace} onChange={setPace} />
        </div>
      </div>
    </div>
  );
}
