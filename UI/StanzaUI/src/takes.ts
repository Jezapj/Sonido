/**
 * takes
 *
 * Recorded takes and the "guide" take shown in the Bars / Score views.
 * A take keeps string + fret per note so the tab survives; MIDI is only the
 * exchange format (one channel per guitar string, which DAWs and Guitar Pro
 * both understand).
 */

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { assignFingering, newFingeringState, STANDARD_TUNING, FRET_COUNT } from "./music";
import { decodeMidi, encodeMidi } from "./midi";
import { startRecording, stopRecording, type NoteEvent } from "./pitchTracker";

export interface TakeNote {
  midi: number;
  startMs: number;
  durMs: number;
  velocity: number;
  string: number | null;
  fret: number | null;
}

export interface Take {
  id: string;
  name: string;
  createdAt: number;
  bpm: number;
  timeSig: [number, number];
  durationMs: number;
  notes: TakeNote[];
}

const STRING_CHANNEL_TAG = "stanza:channel=string";
const GM_CLEAN_GUITAR = 27;
/** How far ahead of the play line the guide starts, so the first notes scroll in. */
export const GUIDE_LEAD_MS = 3000;
/** A live note counts as a hit if it starts this close to the guide note. */
const HIT_WINDOW_MS = 250;

// ── Store ─────────────────────────────────────────────────────────────────────

interface TakeSnapshot {
  recording: boolean;
  recordStartedAt: number;
  pending: Take | null;
  guide: Take | null;
  guidePlaying: boolean;
}

let snap: TakeSnapshot = {
  recording: false, recordStartedAt: 0, pending: null, guide: null, guidePlaying: false,
};
const listeners = new Set<() => void>();

function update(patch: Partial<TakeSnapshot>) {
  snap = { ...snap, ...patch };
  listeners.forEach(fn => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useTakes(): TakeSnapshot {
  return useSyncExternalStore(subscribe, () => snap);
}

export const getGuide = (): Take | null => snap.guide;

// ── Tempo (published by the metronome) ────────────────────────────────────────

let tempo = { bpm: 120, timeSig: [4, 4] as [number, number] };

export function setTempo(bpm: number, beats: number, noteValue: number) {
  tempo = { bpm, timeSig: [beats, noteValue] };
}

// ── Recording ─────────────────────────────────────────────────────────────────

export function beginRecording() {
  if (snap.recording) return;
  startRecording();
  update({ recording: true, recordStartedAt: performance.now() });
}

export function endRecording() {
  const rec = stopRecording();
  const take = rec ? takeFromNotes(rec.notes) : null;
  update({ recording: false, ...(take && { pending: take }) });
}

export const discardPending = () => update({ pending: null });

function takeFromNotes(notes: NoteEvent[]): Take | null {
  if (notes.length === 0) return null;
  const t0 = notes[0].start;
  const maxDb = Math.max(...notes.map(n => 20 * Math.log10(Math.max(n.peak, 1e-6))));
  const out: TakeNote[] = notes.map(n => {
    const db = 20 * Math.log10(Math.max(n.peak, 1e-6));
    const rel = Math.min(1, Math.max(0, (db - (maxDb - 30)) / 30));
    return {
      midi: n.midi,
      startMs: n.start - t0,
      durMs: Math.max(30, (n.end ?? n.start) - n.start),
      velocity: Math.round(40 + rel * 87),
      string: n.string,
      fret: n.fret,
    };
  });
  const last = out[out.length - 1];
  return {
    id: `take-${Date.now()}`,
    name: "Take",
    createdAt: Date.now(),
    bpm: tempo.bpm,
    timeSig: tempo.timeSig,
    durationMs: last.startMs + last.durMs,
    notes: out,
  };
}

/** Hand the pending take to a song (the caller stores it). */
export function claimPending(name: string): Take | null {
  const t = snap.pending;
  if (!t) return null;
  update({ pending: null });
  return { ...t, name };
}

// ── Guide playback ────────────────────────────────────────────────────────────

let guideStartAt = 0;            // performance.now() at which take time 0 hits the play line
let guidePausedAt = -GUIDE_LEAD_MS;
let judged = new Int8Array(0);   // -1 pending, 0 missed, 1 hit
let judgeFrom = 0;

function resetJudging() {
  judged = new Int8Array(snap.guide?.notes.length ?? 0).fill(-1);
  judgeFrom = 0;
}

export function loadGuide(take: Take) {
  guidePausedAt = -GUIDE_LEAD_MS;
  update({ guide: take, guidePlaying: false });
  resetJudging();
}

export function unloadGuide() {
  update({ guide: null, guidePlaying: false });
  resetJudging();
}

export function playGuide() {
  if (!snap.guide) return;
  guideStartAt = performance.now() + GUIDE_LEAD_MS;
  resetJudging();
  update({ guidePlaying: true });
}

export function stopGuide() {
  guidePausedAt = -GUIDE_LEAD_MS;
  update({ guidePlaying: false });
}

/** Current position in the guide take (ms). Stops playback once the take has passed. */
export function guideTime(now: number): number {
  const g = snap.guide;
  if (!g) return 0;
  if (!snap.guidePlaying) return guidePausedAt;
  const t = now - guideStartAt;
  if (t > g.durationMs + 1500) { stopGuide(); return guidePausedAt; }
  return t;
}

/** Score guide notes against what was actually played. Call once per frame. */
export function judgeGuide(live: readonly NoteEvent[], now: number) {
  const g = snap.guide;
  if (!g || !snap.guidePlaying) return;
  if (judged.length !== g.notes.length) resetJudging();
  for (let i = judgeFrom; i < g.notes.length; i++) {
    const at = guideStartAt + g.notes[i].startMs;
    if (at - HIT_WINDOW_MS > now) break;
    if (judged[i] === -1) {
      for (let j = live.length - 1; j >= 0; j--) {
        const l = live[j];
        if (l.start < at - HIT_WINDOW_MS) break;
        if (l.start <= at + HIT_WINDOW_MS && l.midi === g.notes[i].midi) { judged[i] = 1; break; }
      }
      if (judged[i] === -1 && now > at + HIT_WINDOW_MS) judged[i] = 0;
    }
    if (judged[i] !== -1 && i === judgeFrom) judgeFrom++;
  }
}

export const guideJudgement = (i: number): number => judged[i] ?? -1;

export function guideScore(): { hit: number; judged: number; total: number } {
  let hit = 0, done = 0;
  for (const j of judged) { if (j === 1) hit++; if (j !== -1) done++; }
  return { hit, judged: done, total: judged.length };
}

// ── MIDI ──────────────────────────────────────────────────────────────────────

export function takeToMidi(take: Take): Uint8Array {
  return encodeMidi({
    name: take.name,
    bpm: take.bpm,
    timeSig: take.timeSig,
    program: GM_CLEAN_GUITAR,
    channels: [0, 1, 2, 3, 4, 5],
    text: STRING_CHANNEL_TAG,
    notes: take.notes.map(n => ({
      midi: n.midi, startMs: n.startMs, durMs: n.durMs, velocity: n.velocity,
      channel: n.string ?? 0,
    })),
  });
}

export function midiToTake(bytes: Uint8Array, fallbackName: string): Take {
  const m = decodeMidi(bytes);
  if (m.notes.length === 0) throw new Error("No notes found in this MIDI file");

  const fits = (ch: number, midi: number) =>
    ch < 6 && midi - STANDARD_TUNING[ch] >= 0 && midi - STANDARD_TUNING[ch] <= FRET_COUNT;
  const usedChannels = new Set(m.notes.map(n => n.channel));
  const channelIsString = m.texts.includes(STRING_CHANNEL_TAG)
    || (usedChannels.size > 1 && m.notes.every(n => fits(n.channel, n.midi)));

  const t0 = m.notes[0].startMs;
  const fing = newFingeringState();
  const notes: TakeNote[] = m.notes.map(n => {
    let string: number | null = null, fret: number | null = null;
    if (channelIsString && fits(n.channel, n.midi)) {
      string = n.channel; fret = n.midi - STANDARD_TUNING[n.channel];
    } else {
      const f = assignFingering(n.midi, fing);
      if (f) { string = f.string; fret = f.fret; }
    }
    return { midi: n.midi, startMs: n.startMs - t0, durMs: n.durMs, velocity: n.velocity, string, fret };
  });

  const durationMs = Math.max(...notes.map(n => n.startMs + n.durMs));
  return {
    id: `take-${Date.now()}`,
    name: m.name || fallbackName,
    createdAt: Date.now(),
    bpm: m.bpm,
    timeSig: m.timeSig,
    durationMs,
    notes,
  };
}

/** Ask for a location and write the take as a .mid file. Returns false if cancelled. */
export async function exportTakeMidi(take: Take, songTitle?: string): Promise<boolean> {
  const bytes = takeToMidi(take);
  const base = [songTitle, take.name].filter(Boolean).join(" - ").replace(/[\\/:*?"<>|]+/g, "_") || "take";
  try {
    const path = await save({
      defaultPath: `${base}.mid`,
      filters: [{ name: "MIDI", extensions: ["mid", "midi"] }],
    });
    if (!path) return false;
    await invoke("write_binary_file", { path, data: Array.from(bytes) });
    return true;
  } catch (e) {
    console.warn("[takes] native save failed, falling back to download:", e);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "audio/midi" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}.mid`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
