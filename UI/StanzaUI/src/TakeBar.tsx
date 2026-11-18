import { useEffect, useState } from "react";
import { useIsLightMode } from "./UseTheme";
import { updatePractice, useProfileValue } from "./profileStore";
import {
  beginRecording, discardPending, endRecording, exportTakeMidi, fmtDuration,
  guideScore, MAX_TRANSPOSE, playGuide, setGuideSound, setGuideTranspose, stopGuide, tempoLabel,
  toggleLiveSync, unloadGuide, useTakes,
} from "./takes";

const fmtSemis = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0");

const REC = "#ef4444";

/** Re-render every 250 ms while `active` (recording timer, guide score). */
function useTicker(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick(n => n + 1), 250);
    return () => clearInterval(id);
  }, [active]);
}

/** Record / stop button; `base` matches the surrounding header buttons. */
export function RecButton({ connected, base }: { connected: boolean; base: React.CSSProperties }) {
  const t = useTakes();
  useTicker(t.recording);
  const off = !connected && !t.recording;
  return (
    <button
      type="button"
      onClick={() => (t.recording ? endRecording() : beginRecording())}
      disabled={off}
      title={t.recording ? "Stop recording" : "Record the notes you play"}
      style={{
        ...base,
        opacity: off ? 0.4 : 1,
        borderColor: t.recording ? REC : "rgba(239,68,68,0.45)",
        color: REC,
        background: t.recording ? "rgba(239,68,68,0.14)" : "transparent",
        display: "inline-flex", alignItems: "center", gap: 6,
      }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: t.recording ? 1 : "50%", background: REC,
        animation: t.recording ? "rse-pulse 1.1s infinite" : "none",
      }} />
      {t.recording ? `STOP ${fmtDuration(performance.now() - t.recordStartedAt)}` : "REC"}
    </button>
  );
}

/** Draw live notes on the metronome's grid (bars, note lengths) without recording. */
export function SyncButton({ base }: { base: React.CSSProperties }) {
  const t = useTakes();
  const light = useIsLightMode();
  const accent = light ? "#6d28d9" : "#AFA9EC";
  const title = t.guide
    ? "Follows the guide take while one is loaded"
    : t.liveSync
      ? "Back to free time"
      : "Start the metronome and show what you play in time: bars and note lengths";
  return (
    <button
      type="button"
      onClick={toggleLiveSync}
      title={title}
      style={{
        ...base,
        opacity: t.guide ? 0.5 : 1,
        ...(t.liveSync && { borderColor: accent, color: accent, background: "rgba(175,169,236,0.14)" }),
      }}
    >
      ♩ SYNC
    </button>
  );
}

/** Whether TakePanel has anything to show. */
export function useTakePanelVisible(): boolean {
  const t = useTakes();
  return (!!t.pending && !t.recording) || !!t.guide;
}

/** The unsaved take and the loaded guide take, stacked down the right of the views. */
export default function TakePanel() {
  const t = useTakes();
  const light = useIsLightMode();
  const sound = useProfileValue(d => d.practice.guideSound);
  useEffect(() => { setGuideSound(sound); }, [sound]);
  const semis = useProfileValue(d => d.practice.transpose ?? 0);
  useEffect(() => { setGuideTranspose(semis); }, [semis]);
  const shiftBy = (d: number) =>
    updatePractice({ transpose: Math.max(-MAX_TRANSPOSE, Math.min(MAX_TRANSPOSE, semis + d)) });
  useTicker(t.guidePlaying);

  const ink = light ? "rgba(26,15,46,0.75)" : "rgba(255,255,255,0.75)";
  const dim = light ? "rgba(26,15,46,0.45)" : "rgba(255,255,255,0.4)";
  const line = light ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.22)";
  const guideCol = light ? "#c2410c" : "#F5B971";
  const accent = light ? "#6d28d9" : "#AFA9EC";

  const btn: React.CSSProperties = {
    fontFamily: "monospace", fontSize: 10, letterSpacing: "0.06em",
    cursor: "pointer", borderRadius: 7, padding: "2px 8px",
    border: `0.5px solid ${line}`, background: "transparent", color: ink,
    whiteSpace: "nowrap", lineHeight: "1.5", width: "100%",
  };
  const close: React.CSSProperties = { ...btn, width: "auto", padding: "0 5px", fontSize: 9 };
  const text: React.CSSProperties = {
    fontFamily: "monospace", fontSize: 10, whiteSpace: "nowrap",
    overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, color: ink,
  };
  const label: React.CSSProperties = { ...text, fontSize: 9, letterSpacing: "0.12em" };
  const section: React.CSSProperties = {
    flex: "1 0 auto", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 4,
  };
  const header: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 };

  const score = t.guide ? guideScore() : null;
  const showPending = !!t.pending && !t.recording;
  if (!showPending && !t.guide) return null;

  return (
    <>
      {t.guide && (
        <div style={section}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <div style={header}>
              <span style={{ ...label, color: guideCol }}>GUIDE</span>
              <button type="button" style={close} title="Remove guide" onClick={unloadGuide}>✕</button>
            </div>
            <span style={text} title={t.guide.name}>{t.guide.name}</span>
            {(t.guide.sync || (score && score.judged > 0)) && (
              <span style={{ ...text, color: dim }}>
                {[t.guide.sync && tempoLabel(t.guide), score && score.judged > 0 && `${score.hit}/${score.total}`]
                  .filter(Boolean).join(" · ")}
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 3 }} title="Transpose the guide: score, piano and hit-checking all move">
              <button type="button" style={{ ...btn, width: "auto", padding: "0 6px" }}
                disabled={semis <= -MAX_TRANSPOSE} onClick={() => shiftBy(-1)} aria-label="Transpose down a semitone">−</button>
              <button
                type="button"
                onClick={() => updatePractice({ transpose: 0 })}
                title={semis ? "Back to the key it was recorded in" : "Transposed by semitones"}
                style={{
                  ...btn, padding: "0 2px", flex: 1, minWidth: 0,
                  border: "none", fontVariantNumeric: "tabular-nums",
                  color: semis ? accent : dim,
                }}
              >
                KEY {fmtSemis(semis)}
              </button>
              <button type="button" style={{ ...btn, width: "auto", padding: "0 6px" }}
                disabled={semis >= MAX_TRANSPOSE} onClick={() => shiftBy(1)} aria-label="Transpose up a semitone">+</button>
            </div>
            <button
              type="button"
              onClick={() => (t.guidePlaying ? stopGuide() : playGuide())}
              style={{
                ...btn, borderColor: guideCol, color: guideCol,
                background: t.guidePlaying ? "rgba(245,185,113,0.14)" : "transparent",
              }}
            >
              {t.guidePlaying ? "■ STOP" : "▶ PLAY"}
            </button>
            <button
              type="button"
              onClick={() => updatePractice({ guideSound: !sound })}
              aria-pressed={sound}
              title={sound ? "Mute the piano during playback" : "Sound out the take's notes on a piano during playback"}
              style={{
                ...btn,
                ...(sound
                  ? { borderColor: accent, color: accent, background: "rgba(175,169,236,0.12)" }
                  : { color: dim }),
              }}
            >
              {sound ? "♪ PIANO ON" : "♪ PIANO OFF"}
            </button>
          </div>
        </div>
      )}

      {t.guide && showPending && <div style={{ borderTop: `0.5px solid ${line}`, flexShrink: 0 }} />}

      {showPending && t.pending && (
        <div style={section}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <div style={header}>
              <span style={{ ...label, color: accent }}>TAKE</span>
              <button type="button" style={close} title="Discard this take" onClick={discardPending}>✕</button>
            </div>
            <span style={text}>{fmtDuration(t.pending.durationMs)} · {t.pending.notes.length} notes</span>
            {t.pending.sync && <span style={{ ...text, color: dim }}>{tempoLabel(t.pending)}</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <button type="button" style={btn} title="Export as a MIDI file"
              onClick={() => { if (t.pending) void exportTakeMidi(t.pending); }}>
              MIDI
            </button>
            <span style={{ ...text, color: dim, fontSize: 9, whiteSpace: "normal", lineHeight: 1.3 }}>
              save it to a song in SONGS
            </span>
          </div>
        </div>
      )}
    </>
  );
}
