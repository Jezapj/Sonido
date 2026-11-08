import { useEffect, useState } from "react";
import { useIsLightMode } from "./UseTheme";
import {
  beginRecording, discardPending, endRecording, exportTakeMidi, fmtDuration,
  guideScore, playGuide, stopGuide, tempoLabel, toggleLiveSync, unloadGuide, useTakes,
} from "./takes";

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

/** The unsaved take and the loaded guide take (above Bars / Score). */
export default function TakeBar() {
  const t = useTakes();
  const light = useIsLightMode();
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
    whiteSpace: "nowrap", lineHeight: "1.5",
  };
  const chip: React.CSSProperties = {
    fontFamily: "monospace", fontSize: 10, whiteSpace: "nowrap",
    overflow: "hidden", textOverflow: "ellipsis", minWidth: 0,
  };

  const score = t.guide ? guideScore() : null;
  const showPending = !!t.pending && !t.recording;
  if (!showPending && !t.guide) return null;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
      rowGap: 4, marginBottom: 5, minHeight: 22,
    }}>
      {showPending && t.pending && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
          <span style={{ ...chip, color: accent }}>
            TAKE {fmtDuration(t.pending.durationMs)} · {t.pending.notes.length} notes
            {t.pending.sync ? ` · ${tempoLabel(t.pending)}` : ""}
          </span>
          <button type="button" style={btn} title="Export as a MIDI file"
            onClick={() => { if (t.pending) void exportTakeMidi(t.pending); }}>
            MIDI
          </button>
          <button type="button" style={{ ...btn, padding: "2px 6px" }} title="Discard this take"
            onClick={discardPending}>
            ✕
          </button>
          <span style={{ ...chip, color: dim, fontSize: 9 }}>save it to a song in SONGS</span>
        </div>
      )}

      {t.guide && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, marginLeft: "auto" }}>
          <span style={{ ...chip, color: guideCol, maxWidth: 140 }} title={t.guide.name}>
            GUIDE · {t.guide.name}
          </span>
          {t.guide.sync && <span style={{ ...chip, color: dim }}>{tempoLabel(t.guide)}</span>}
          {score && score.judged > 0 && (
            <span style={{ ...chip, color: dim }}>{score.hit}/{score.total}</span>
          )}
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
          <button type="button" style={{ ...btn, padding: "2px 6px" }} title="Remove guide"
            onClick={unloadGuide}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
