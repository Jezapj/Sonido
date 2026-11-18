/**
 * The metronome laid out for touch. The engine (click scheduling, the grid the
 * note views sync to, guide count-ins) is DashboardMetronome's; this only draws it.
 */

import { useEffect, useRef } from "react";
import DashboardMetronome, { BPM_MAX, BPM_MIN, type MetronomeControls } from "../DashboardMetronome";
import { TouchSlider } from "./controls";

export interface MetronomeStatus { running: boolean; beat: number; accented: boolean; }

/** Taps further apart than this start a new count. */
const TAP_RESET_MS = 2000;
const TAP_WINDOW = 5;

function Layout({ m, onStatus }: { m: MetronomeControls; onStatus?: (s: MetronomeStatus) => void }) {
  const taps = useRef<number[]>([]);
  const accented = m.activeBeat >= 0 && !!m.accents[m.activeBeat];

  useEffect(() => {
    onStatus?.({ running: m.running, beat: m.activeBeat, accented });
  }, [m.running, m.activeBeat, accented, onStatus]);

  const tapTempo = () => {
    const now = performance.now();
    const list = taps.current;
    if (list.length && now - list[list.length - 1] > TAP_RESET_MS) list.length = 0;
    list.push(now);
    if (list.length > TAP_WINDOW) list.shift();
    if (list.length < 2) return;
    const avg = (list[list.length - 1] - list[0]) / (list.length - 1);
    m.setBpm(60000 / avg);
  };

  const nudge = (d: number) => m.setBpm(m.bpm + d);
  const lit = m.running && m.activeBeat >= 0;

  return (
    <div className="ts-metro">
      <div className="ts-metro__main">
        <div className="ts-metro__tempo">
          <button type="button" className="ts-btn ts-btn--step" onClick={() => nudge(-5)} aria-label="5 BPM slower">−5</button>
          <button type="button" className="ts-btn ts-btn--step" onClick={() => nudge(-1)} aria-label="1 BPM slower">−1</button>
          <div className="ts-metro__bpm" aria-live="polite">
            <strong>{Math.round(m.bpm)}</strong>
            <span>BPM</span>
          </div>
          <button type="button" className="ts-btn ts-btn--step" onClick={() => nudge(1)} aria-label="1 BPM faster">+1</button>
          <button type="button" className="ts-btn ts-btn--step" onClick={() => nudge(5)} aria-label="5 BPM faster">+5</button>
        </div>

        <TouchSlider label="Tempo" value={m.bpm} min={BPM_MIN} max={BPM_MAX} onChange={m.setBpm} />

        <div className="ts-metro__beats" aria-label="Beats: tap one to accent it">
          {m.accents.map((on, i) => (
            <button
              key={i}
              type="button"
              className={`ts-beat${on ? " is-accent" : ""}${m.activeBeat === i ? " is-lit" : ""}`}
              onClick={() => m.toggleAccent(i)}
              aria-pressed={on}
              aria-label={`Beat ${i + 1}${on ? ", accented" : ""}`}
            >
              {i + 1}
            </button>
          ))}
        </div>

        <div className="ts-metro__row">
          <div className="ts-stepper" aria-label="Time signature">
            <button type="button" className="ts-btn ts-btn--icon" onClick={() => m.cycleSig(-1)} aria-label="Previous time signature">‹</button>
            <strong>{m.sig.label}</strong>
            <button type="button" className="ts-btn ts-btn--icon" onClick={() => m.cycleSig(1)} aria-label="Next time signature">›</button>
          </div>
          <button type="button" className="ts-btn ts-btn--accent ts-metro__tap" onClick={tapTempo}>TAP TEMPO</button>
          <div className="ts-field ts-metro__vol">
            <div className="ts-field__head">
              <span>CLICK VOLUME</span>
              <span className="ts-field__value">{Math.round(m.volume * 100)}</span>
            </div>
            <TouchSlider label="Click volume" value={m.volume} min={0} max={1} onChange={m.setVolume} />
          </div>
        </div>
      </div>

      <button
        type="button"
        className={`ts-metro__go${m.running ? " is-running" : ""}`}
        onClick={m.toggle}
      >
        {/* Re-keyed per beat so the flash restarts on every click; the button itself stays put */}
        {lit && <span key={m.activeBeat} className={`ts-metro__flash${accented ? " is-accent" : ""}`} />}
        <strong>{m.running ? "STOP" : "START"}</strong>
        <span>{m.running ? `beat ${m.activeBeat + 1} of ${m.sig.beats}` : m.sig.label}</span>
      </button>
    </div>
  );
}

export default function TouchMetronome({ onStatus }: { onStatus?: (s: MetronomeStatus) => void }) {
  return <DashboardMetronome render={m => <Layout m={m} onStatus={onStatus} />} />;
}
