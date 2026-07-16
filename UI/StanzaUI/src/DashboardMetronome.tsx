import { useCallback, useEffect, useRef, useState, FC } from "react";

export type TimeSig = { beats: number; noteValue: number; label: string };

export const TIME_SIGNATURES: TimeSig[] = [
  { beats: 2, noteValue: 4, label: "2/4" },
  { beats: 3, noteValue: 4, label: "3/4" },
  { beats: 4, noteValue: 4, label: "4/4" },
  { beats: 5, noteValue: 4, label: "5/4" },
  { beats: 6, noteValue: 4, label: "6/4" },
  { beats: 7, noteValue: 4, label: "7/4" },
  { beats: 3, noteValue: 8, label: "3/8" },
  { beats: 5, noteValue: 8, label: "5/8" },
  { beats: 6, noteValue: 8, label: "6/8" },
  { beats: 7, noteValue: 8, label: "7/8" },
  { beats: 9, noteValue: 8, label: "9/8" },
  { beats: 12, noteValue: 8, label: "12/8" },
];

function defaultAccents(sig: TimeSig): boolean[] {
  const accents = Array.from({ length: sig.beats }, () => false);
  accents[0] = true;
  if (sig.noteValue === 8 && sig.beats % 3 === 0) {
    for (let i = 3; i < sig.beats; i += 3) accents[i] = true;
  } else if (sig.beats >= 6 && sig.noteValue === 4) {
    accents[Math.floor(sig.beats / 2)] = true;
  }
  return accents;
}

const btnBase: React.CSSProperties = {
  background: "transparent",
  border: "0.5px solid rgba(255,255,255,0.25)",
  color: "#ffffff",
  borderRadius: 8,
  padding: "4px 10px",
  fontSize: 11,
  fontFamily: "monospace",
  cursor: "pointer",
  letterSpacing: "0.04em",
  whiteSpace: "nowrap" as const,
};

const DashboardMetronome: FC = () => {
  const [bpm, setBpm] = useState(120);
  const [sigIdx, setSigIdx] = useState(2);
  const [accents, setAccents] = useState<boolean[]>(() => defaultAccents(TIME_SIGNATURES[2]));
  const [volume, setVolume] = useState(0.7);
  const [running, setRunning] = useState(false);
  const [activeBeat, setActiveBeat] = useState(-1);

  const sig = TIME_SIGNATURES[sigIdx];

  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextNoteRef = useRef(0);
  const beatRef = useRef(0);
  const bpmRef = useRef(bpm);
  const accentsRef = useRef(accents);
  const beatsRef = useRef(sig.beats);
  const volumeRef = useRef(volume);
  const runningRef = useRef(false);

  useEffect(() => { bpmRef.current = bpm; }, [bpm]);
  useEffect(() => { accentsRef.current = accents; }, [accents]);
  useEffect(() => { beatsRef.current = sig.beats; }, [sig.beats]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = volume;
  }, [volume]);

  const ensureAudio = useCallback(() => {
    if (!ctxRef.current || ctxRef.current.state === "closed") {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      const gain = ctx.createGain();
      gain.gain.value = volumeRef.current;
      gain.connect(ctx.destination);
      ctxRef.current = ctx;
      gainRef.current = gain;
    }
    if (ctxRef.current.state === "suspended") ctxRef.current.resume().catch(() => {});
    return ctxRef.current;
  }, []);

  const scheduleClick = useCallback((time: number, accented: boolean) => {
    const ctx = ctxRef.current;
    const master = gainRef.current;
    if (!ctx || !master) return;

    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = accented ? 1320 : 880;

    const peak = accented ? 0.85 : 0.45;
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(peak, time + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, time + (accented ? 0.06 : 0.04));

    osc.connect(env);
    env.connect(master);
    osc.start(time);
    osc.stop(time + 0.08);
  }, []);

  const scheduler = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const LOOKAHEAD = 0.12;
    const secondsPerBeat = 60.0 / Math.max(20, bpmRef.current);

    while (nextNoteRef.current < ctx.currentTime + LOOKAHEAD) {
      const beat = beatRef.current;
      const accented = accentsRef.current[beat] ?? false;
      scheduleClick(nextNoteRef.current, accented);
      setActiveBeat(beat);
      beatRef.current = (beat + 1) % Math.max(1, beatsRef.current);
      nextNoteRef.current += secondsPerBeat;
    }
  }, [scheduleClick]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setActiveBeat(-1);
  }, []);

  const start = useCallback(() => {
    const ctx = ensureAudio();
    beatRef.current = 0;
    nextNoteRef.current = ctx.currentTime + 0.05;
    runningRef.current = true;
    setRunning(true);
    scheduler();
    timerRef.current = setInterval(scheduler, 25);
  }, [ensureAudio, scheduler]);

  const toggle = useCallback(() => {
    if (runningRef.current) stop();
    else start();
  }, [start, stop]);

  useEffect(() => () => {
    stop();
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    gainRef.current = null;
  }, [stop]);

  const cycleSig = (dir: -1 | 1) => {
    const next = (sigIdx + dir + TIME_SIGNATURES.length) % TIME_SIGNATURES.length;
    const nextSig = TIME_SIGNATURES[next];
    setSigIdx(next);
    setAccents(defaultAccents(nextSig));
    beatRef.current = 0;
  };

  const toggleAccent = (i: number) => {
    setAccents(prev => {
      const next = [...prev];
      next[i] = !next[i];
      return next;
    });
  };

  useEffect(() => {
    setAccents(prev => (prev.length === sig.beats ? prev : defaultAccents(sig)));
  }, [sig]);

  return (
    <div
      className="da-metro"
      style={{
        width: 300,
        height: 168,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        boxSizing: "border-box",
        userSelect: "none",
      }}
    >
      <div className="da-bpm-row" style={{ display: "flex", alignItems: "center", gap: 8, boxShadow: "none" }}>
        <div className="da-bpm-block" style={{ flex: 1, minWidth: 0, boxShadow: "none" }}>
          <div style={{
            fontFamily: "monospace", fontSize: 10, letterSpacing: "0.08em",
            color: "rgba(255,255,255,0.4)", marginBottom: 2, alignContent: "center", left: "30px",
          }}>BPM</div>
          <div className="da-bpm-block" style={{ display: "flex", alignItems: "baseline", gap: 8, boxShadow: "none" }}>
            <span style={{
              fontFamily: "monospace", fontSize: 28, fontWeight: 800, top: "-12px",
              color: "#AFA9EC", lineHeight: 1, letterSpacing: "-0.02em", position: "relative",
            }}>{bpm}</span>
            <input
              className="da-bpm-slider"
              type="range" min={40} max={240} step={1} value={bpm}
              onChange={e => setBpm(Number(e.target.value))}
              style={{ flex: 1, accentColor: "#AFA9EC", cursor: "pointer", boxShadow: "none" }}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={toggle}
          style={{
            ...btnBase,
            padding: "30px 12px 30px 12px",
            margin: "0px 0 0 0",
            fontWeight: 700,
            borderColor: running ? "rgba(239,68,68,0.7)" : "rgba(34,197,94,0.55)",
            color: running ? "#ef4444" : "#86efac",
            background: running ? "rgba(239,68,68,0.1)" : "rgba(34,197,94,0.1)",
            flexShrink: 0,
          }}
        >
          {running ? "STOP" : "START"}
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 25,  }}>
        <span style={{
          fontFamily: "monospace", fontSize: 10, letterSpacing: "0.08em",
          color: "rgba(255,255,255,0.4)", width: 52, flexShrink: 0,
        }}>TIME</span>
        <button type="button" onClick={() => cycleSig(-1)} style={{ ...btnBase, padding: "2px 8px" }}>&lsaquo;</button>
        <span className="da-sig-label" style={{
          fontFamily: "monospace", fontSize: 16, fontWeight: 700,
          color: "#fff", minWidth: 48, textAlign: "center",
        }}>{sig.label}</span>
        <button type="button" onClick={() => cycleSig(1)} style={{ ...btnBase, padding: "2px 8px" }}>&rsaquo;</button>
      </div>

      <div>
        <div style={{
          fontFamily: "monospace", fontSize: 10, letterSpacing: "0.08em",
          color: "rgba(255,255,255,0.4)", marginBottom: 4,
        }}>
          ACCENTS - tap to toggle
        </div>
        <div style={{
          display: "flex", gap: 3, flexWrap: "wrap", alignItems: "center", justifyContent: "center",
          minHeight: 28,
        }}>
          {accents.map((on, i) => {
            const lit = activeBeat === i;
            return (
              <button
                key={i}
                type="button"
                onClick={() => toggleAccent(i)}
                title={on ? `Beat ${i + 1}: accented` : `Beat ${i + 1}: normal`}
                style={{
                  width: sig.beats > 8 ? 22 : 26,
                  height: sig.beats > 8 ? 22 : 26,
                  borderRadius: "50%",
                  border: `1.5px solid ${on ? "rgba(175,169,236,0.85)" : "rgba(255,255,255,0.25)"}`,
                  background: lit
                    ? (on ? "#AFA9EC" : "rgba(255,255,255,0.55)")
                    : (on ? "rgba(175,169,236,0.28)" : "transparent"),
                  color: lit ? "#0d0b12" : (on ? "#AFA9EC" : "rgba(255,255,255,0.45)"),
                  fontFamily: "monospace",
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: "pointer",
                  padding: 0,
                  boxShadow: lit ? "0 0 10px rgba(175,169,236,0.55)" : "none",
                  transition: "background 0.05s, box-shadow 0.05s",
                }}
              >
                {i + 1}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "auto" }}>
        <span style={{
          fontFamily: "monospace", fontSize: 10, letterSpacing: "0.08em",
          color: "rgba(255,255,255,0.4)", width: 52, flexShrink: 0,
        }}>VOL</span>
        <input
          type="range" min={0} max={1} step={0.01} value={volume}
          onChange={e => setVolume(Number(e.target.value))}
          style={{ flex: 1, accentColor: "#AFA9EC", cursor: "pointer" }}
        />
        <span style={{
          fontFamily: "monospace", fontSize: 11,
          color: "rgba(255,255,255,0.55)", minWidth: 28, textAlign: "right",
        }}>
          {Math.round(volume * 100)}
        </span>
      </div>
    </div>
  );
};

export default DashboardMetronome;
