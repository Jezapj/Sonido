import { ConfirmButton, TouchSlider } from "./controls";
import { fmtLoopTime, type Looper, type LooperState } from "./useLooper";

const RING_R = 54;
const RING_CIRC = 2 * Math.PI * RING_R;

/** How each state reads on screen, and what the next tap on the pad will do. */
export const LOOPER_META: Record<LooperState, { label: string; tone: string; pulse: boolean; action: string; hint: string }> = {
  Idle:        { label: "READY",     tone: "idle", pulse: false, action: "● REC",      hint: "Tap to record a loop" },
  Recording:   { label: "RECORDING", tone: "rec",  pulse: true,  action: "■ FINISH",   hint: "Tap to close the loop and play it" },
  Playing:     { label: "PLAYING",   tone: "play", pulse: false, action: "◉ OVERDUB",  hint: "Tap to layer on top" },
  Overdubbing: { label: "OVERDUB",   tone: "dub",  pulse: true,  action: "■ FINISH",   hint: "Tap to stop layering" },
  Stopped:     { label: "STOPPED",   tone: "idle", pulse: false, action: "● NEW LOOP", hint: "Tap to record over this loop" },
};

export default function TouchLooper({ looper }: { looper: Looper }) {
  const { info, mix, feedback, busy } = looper;
  const meta = LOOPER_META[info.state] ?? LOOPER_META.Idle;
  const hasLoop = info.state !== "Idle";
  const stopped = info.state === "Stopped";
  const looping = info.state === "Playing" || info.state === "Overdubbing";
  const shownTime = info.state === "Recording" ? info.loop_len_secs : info.play_pos_secs;

  return (
    <div className={`ts-looper ts-looper--${meta.tone}`}>
      <button
        type="button"
        className={`ts-looper__pad${meta.pulse ? " is-pulsing" : ""}`}
        onClick={looper.tap}
        aria-label={`${meta.action}. ${meta.hint}`}
      >
        <span className="ts-looper__ring">
          <svg viewBox="0 0 130 130" aria-hidden="true">
            <circle cx={65} cy={65} r={RING_R} className="ts-looper__ring-track" />
            <circle
              cx={65} cy={65} r={RING_R}
              className="ts-looper__ring-fill"
              strokeDasharray={RING_CIRC}
              strokeDashoffset={RING_CIRC * (1 - info.progress)}
              transform="rotate(-90 65 65)"
            />
          </svg>
          <span className="ts-looper__time">
            <strong>{fmtLoopTime(shownTime)}</strong>
            <span>{info.loop_len_secs > 0 && info.state !== "Recording" ? `/ ${fmtLoopTime(info.loop_len_secs)}` : meta.label}</span>
          </span>
        </span>
        <span className="ts-looper__action">{meta.action}</span>
        <span className="ts-looper__hint">{meta.hint}</span>
      </button>

      <div className="ts-looper__side">
        <div className="ts-looper__status">
          <span className="ts-looper__dot" />
          {meta.label}
        </div>

        <div className="ts-looper__transport">
          {stopped ? (
            <button type="button" className="ts-btn ts-btn--good" onClick={looper.play} disabled={busy}>▶ PLAY</button>
          ) : (
            <button type="button" className="ts-btn ts-btn--bad" onClick={looper.stop} disabled={busy || !hasLoop}>■ STOP</button>
          )}
          <ConfirmButton
            className="ts-btn"
            onConfirm={looper.clear}
            disabled={busy || !hasLoop}
            confirmLabel="ERASE LOOP?"
            title="Erase the loop"
          >
            ✕ CLEAR
          </ConfirmButton>
        </div>

        <div className="ts-field">
          <div className="ts-field__head">
            <span>LOOP VOLUME</span>
            <span className="ts-field__value">{mix.toFixed(2)}</span>
          </div>
          <TouchSlider label="Loop volume" value={mix} min={0} max={4} onChange={looper.setMix} onReset={() => looper.setMix(1)} />
        </div>

        <div className="ts-field">
          <div className="ts-field__head">
            <span>OVERDUB DECAY</span>
            <span className="ts-field__value">{feedback.toFixed(2)}</span>
          </div>
          <TouchSlider label="Overdub decay" value={feedback} min={0.5} max={1} onChange={looper.setFeedback} onReset={() => looper.setFeedback(0.9)} />
        </div>

        <button
          type="button"
          className={`ts-btn ts-btn--row${info.monitor_live ? " is-on" : ""}`}
          onClick={looper.toggleMonitorLive}
          aria-pressed={info.monitor_live}
        >
          <span>MONITOR LIVE INPUT</span>
          <strong>{info.monitor_live ? "ON" : looping ? "OFF · LOOP ONLY" : "OFF"}</strong>
        </button>
      </div>
    </div>
  );
}
