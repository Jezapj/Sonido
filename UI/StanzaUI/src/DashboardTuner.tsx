import { useEffect, useRef, useState } from "react";
import { getPitchFrame } from "./pitchTracker";
import { midiToName, STANDARD_TUNING, STRING_LABELS } from "./music";

/** Cents either side of the target note. Matches a typical chromatic tuner scale. */
const SCALE_CENTS = 50;
/** Needle and note lock green inside this window. */
const IN_TUNE_CENTS = 5;
/** Keep the last stable pitch on screen through brief dropouts. */
const HOLD_MS = 180;
const MIN_CLARITY = 0.86;

interface Readout {
  idle: boolean;
  midi: number;
  cents: number;
  hz: number;
  locked: boolean;
}

const IDLE: Readout = { idle: true, midi: 0, cents: 0, hz: 0, locked: false };

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function formatCents(cents: number): string {
  const v = Math.round(cents * 10) / 10;
  const abs = Math.abs(v).toFixed(1);
  if (v > 0.05) return `+${abs}`;
  if (v < -0.05) return `−${abs}`;
  return "0.0";
}

function sameReadout(a: Readout, b: Readout): boolean {
  if (a.idle !== b.idle || a.locked !== b.locked || a.midi !== b.midi) return false;
  return Math.abs(a.cents - b.cents) < 0.05 && Math.abs(a.hz - b.hz) < 0.05;
}

export default function DashboardTuner() {
  const [readout, setReadout] = useState<Readout>(IDLE);
  const histRef = useRef<number[]>([]);
  const smoothRef = useRef(NaN);
  const noteRef = useRef(-1);
  const lastGoodRef = useRef(0);
  const frameTimeRef = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const frame = getPitchFrame();
      const now = performance.now();
      const heard = frame.voiced
        && frame.clarity >= MIN_CLARITY
        && Number.isFinite(frame.midi);

      let next = IDLE;
      if (heard) {
        if (frame.time !== frameTimeRef.current) {
          frameTimeRef.current = frame.time;
          lastGoodRef.current = frame.time;
          const nearestNow = Math.round(frame.midi);
          if (nearestNow !== noteRef.current) {
            noteRef.current = nearestNow;
            histRef.current = [];
            smoothRef.current = frame.midi;
          }
          const hist = histRef.current;
          hist.push(frame.midi);
          if (hist.length > 5) hist.shift();
          const sorted = [...hist].sort((x, y) => x - y);
          const med = sorted[sorted.length >> 1];
          smoothRef.current = Number.isFinite(smoothRef.current)
            ? smoothRef.current * 0.45 + med * 0.55
            : med;
        }
        const midiF = smoothRef.current;
        const nearest = noteRef.current;
        const cents = (midiF - nearest) * 100;
        next = {
          idle: false,
          midi: nearest,
          cents,
          hz: midiToHz(midiF),
          locked: Math.abs(cents) <= IN_TUNE_CENTS,
        };
      } else if (now - lastGoodRef.current < HOLD_MS && Number.isFinite(smoothRef.current)) {
        const midiF = smoothRef.current;
        const nearest = noteRef.current;
        const cents = (midiF - nearest) * 100;
        next = {
          idle: false,
          midi: nearest,
          cents,
          hz: midiToHz(midiF),
          locked: Math.abs(cents) <= IN_TUNE_CENTS,
        };
      } else {
        histRef.current = [];
        smoothRef.current = NaN;
        noteRef.current = -1;
      }

      setReadout(prev => (sameReadout(prev, next) ? prev : next));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const { idle, midi, cents, hz, locked } = readout;
  const letter = idle ? "—" : midiToName(midi, false).replace("#", "♯");
  const octave = idle ? "" : String(Math.floor(midi / 12) - 1);
  const clamped = Math.max(-SCALE_CENTS, Math.min(SCALE_CENTS, cents));
  const needle = idle ? 50 : ((clamped + SCALE_CENTS) / (SCALE_CENTS * 2)) * 100;
  const status = idle ? "PLAY A NOTE" : locked ? "IN TUNE" : cents < 0 ? "FLAT" : "SHARP";
  const stringIdx = idle ? -1 : STANDARD_TUNING.indexOf(midi);

  const rootClass = [
    "da-tuner",
    idle ? "is-idle" : "",
    locked ? "is-locked" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={rootClass}
      role="meter"
      aria-valuemin={-SCALE_CENTS}
      aria-valuemax={SCALE_CENTS}
      aria-valuenow={idle ? 0 : Math.round(cents * 10) / 10}
      aria-label={idle ? "Tuner listening" : `${letter}${octave} ${formatCents(cents)} cents, ${status}`}
    >
      <div className="da-tuner-head">
        <div className="da-tuner-note">
          {letter}
          {octave && <span className="da-tuner-oct">{octave}</span>}
        </div>
        <div className="da-tuner-cents">{idle ? "— ¢" : `${formatCents(cents)} ¢`}</div>
      </div>

      <div className="da-tuner-meter">
        <span className="da-tuner-side">♭</span>
        <div className="da-tuner-track">
          <div className="da-tuner-zone" />
          <div className="da-tuner-center" />
          {[0, 25, 50, 75, 100].map(p => (
            <span key={p} className="da-tuner-tick" style={{ left: `${p}%` }} />
          ))}
          <div className="da-tuner-needle" style={{ left: `${needle}%` }} />
        </div>
        <span className="da-tuner-side">♯</span>
      </div>

      <div className="da-tuner-meta">
        <span className="da-tuner-status">{status}</span>
        <span className="da-tuner-hz">{idle ? "— Hz" : `${hz.toFixed(1)} Hz`}</span>
      </div>

      <div className="da-tuner-strings" aria-hidden>
        {STRING_LABELS.map((label, i) => (
          <span
            key={label + i}
            className={i === stringIdx ? "da-tuner-string is-hit" : "da-tuner-string"}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
