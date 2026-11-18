/**
 * The looper as the touch layout sees it: live state from the backend plus the
 * commands, in one place so the Looper screen, the Pedals tile and the tab
 * badge all agree. The loop itself lives in Rust (see LooperOverlay.tsx for
 * the desktop view of the same commands).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type LooperState = "Idle" | "Recording" | "Playing" | "Overdubbing" | "Stopped";

export interface LooperInfo {
  state: LooperState;
  loop_len_secs: number;
  play_pos_secs: number;
  progress: number;   // 0.0 – 1.0
  mix: number;
  feedback: number;
  monitor_live: boolean;
}

const IDLE: LooperInfo = {
  state: "Idle", loop_len_secs: 0, play_pos_secs: 0, progress: 0,
  mix: 1.0, feedback: 0.9, monitor_live: false,
};

export interface Looper {
  info: LooperInfo;
  mix: number;
  feedback: number;
  busy: boolean;
  tap: () => void;
  stop: () => void;
  play: () => void;
  clear: () => void;
  setMix: (v: number) => void;
  setFeedback: (v: number) => void;
  toggleMonitorLive: () => void;
}

const isTypingTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement
  && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

export function useLooper(): Looper {
  const [info, setInfo] = useState<LooperInfo>(IDLE);
  const [mix, setMixLocal] = useState(IDLE.mix);
  const [feedback, setFeedbackLocal] = useState(IDLE.feedback);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const paramsRef = useRef({ mix: IDLE.mix, feedback: IDLE.feedback });
  const infoRef = useRef(info);
  infoRef.current = info;

  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | null = null;
    invoke<LooperInfo>("get_looper_info").then(i => {
      if (!alive || !i) return;
      setInfo(i);
      setMixLocal(i.mix);
      setFeedbackLocal(i.feedback);
      paramsRef.current = { mix: i.mix, feedback: i.feedback };
    }).catch(() => {});
    listen<LooperInfo>("looper_info", e => { if (alive) setInfo(e.payload); })
      .then(u => { if (alive) unlisten = u; else u(); })
      .catch(() => {});
    return () => { alive = false; unlisten?.(); };
  }, []);

  /** One command at a time; a tap that lands mid-command is dropped rather than queued. */
  const run = useCallback(async (command: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const next = await invoke<LooperInfo>(command);
      if (next) setInfo(next);
    } catch { /* the board may be away; the state event will catch us up */ }
    finally { busyRef.current = false; setBusy(false); }
  }, []);

  const tap = useCallback(() => { void run("looper_tap"); }, [run]);
  const stop = useCallback(() => { void run("looper_stop"); }, [run]);
  const play = useCallback(() => { void run("looper_play"); }, [run]);
  const clear = useCallback(() => { void run("looper_clear"); }, [run]);

  const pushParams = useCallback(() => {
    invoke("set_looper_params", paramsRef.current).catch(() => {});
  }, []);

  const setMix = useCallback((v: number) => {
    setMixLocal(v);
    paramsRef.current = { ...paramsRef.current, mix: v };
    pushParams();
  }, [pushParams]);

  const setFeedback = useCallback((v: number) => {
    setFeedbackLocal(v);
    paramsRef.current = { ...paramsRef.current, feedback: v };
    pushParams();
  }, [pushParams]);

  const toggleMonitorLive = useCallback(() => {
    const next = !infoRef.current.monitor_live;
    setInfo(i => ({ ...i, monitor_live: next }));
    invoke<LooperInfo>("set_looper_monitor_live", { monitorLive: next })
      .then(i => { if (i) setInfo(i); })
      .catch(() => {});
  }, []);

  // Same keys as the desktop gallery, so a USB footswitch or keyboard keeps working:
  //   Space  record → play → overdub → play     Ctrl  play / stop     Shift (alone)  clear
  useEffect(() => {
    let shiftSolo = false;

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.repeat) return;
      if (e.key === "Shift") { shiftSolo = true; return; }
      if (e.shiftKey) shiftSolo = false;

      if (e.key === "Control") {
        e.preventDefault();
        const state = infoRef.current.state;
        if (state === "Stopped") play();
        else if (state === "Playing" || state === "Overdubbing") stop();
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        // Stopped: Space does nothing (Ctrl resumes). A tap there would wipe the loop.
        if (infoRef.current.state !== "Stopped") tap();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      const solo = shiftSolo && !isTypingTarget(e.target);
      shiftSolo = false;
      if (solo) { e.preventDefault(); clear(); }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [tap, stop, play, clear]);

  return { info, mix, feedback, busy, tap, stop, play, clear, setMix, setFeedback, toggleMonitorLive };
}

export function fmtLoopTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = (secs % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}
