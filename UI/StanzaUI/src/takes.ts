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
import { playNotes, stopNotes } from "./guideSynth";
import { ONSET_LAG_MS, startRecording, stopRecording, type NoteEvent } from "./pitchTracker";
import { barMs, countAt, normalizeDownbeat, type Meter } from "./rhythm";

export interface TakeNote {
  midi: number;
  startMs: number;
  durMs: number;
  velocity: number;
  string: number | null;
  fret: number | null;
}

export interface TakeSync {
  /** Take time (ms) of bar 1, beat 1, in the notes' (detected) timebase. */
  downbeatMs: number;
}

export interface Take {
  id: string;
  name: string;
  createdAt: number;
  bpm: number;                // metronome clicks per minute (one per 1/timeSig[1] note)
  timeSig: [number, number];
  durationMs: number;
  notes: TakeNote[];
  /** Set when the take is tied to the metronome: views draw bars and real note values. */
  sync?: TakeSync | null;
}

export function meterOf(take: Take): Meter | null {
  if (!take.sync) return null;
  return { bpm: take.bpm, num: take.timeSig[0], den: take.timeSig[1], downbeatMs: take.sync.downbeatMs };
}

const STRING_CHANNEL_TAG = "stanza:channel=string";
const UNSYNCED_TAG = "stanza:sync=0";
const GM_CLEAN_GUITAR = 27;
/** How far ahead of the play line the guide starts, so the first notes scroll in. */
export const GUIDE_LEAD_MS = 3000;
/** A live note counts as a hit if it starts within this window around the guide note.
 *  Late is wider: detection lags the pick by the settle frames plus stream latency. */
const HIT_EARLY_MS = 350;
const HIT_LATE_MS = 550;

/** Same pitch, or the same pitch class an octave off (YIN octave slips). */
const pitchMatches = (played: number, wanted: number) =>
  played === wanted || Math.abs(played - wanted) === 12;

// ── Store ─────────────────────────────────────────────────────────────────────

interface TakeSnapshot {
  recording: boolean;
  recordStartedAt: number;
  pending: Take | null;
  guide: Take | null;
  guidePlaying: boolean;
  liveSync: boolean;
}

let snap: TakeSnapshot = {
  recording: false, recordStartedAt: 0, pending: null, guide: null, guidePlaying: false, liveSync: false,
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

// Where the clicks fall, so a take recorded against them keeps their bar lines.
// Times are performance.now() ms at the speaker.
let metro = { running: false, downbeatAt: 0, since: Infinity, stoppedAt: -Infinity };

/** Called by the metronome on every click: `downbeatAt` is any beat-1 click on the
 *  current grid, `since` when that grid (tempo / phase) took effect. */
export function metronomeBeat(downbeatAt: number, since: number) {
  metro = { running: true, downbeatAt, since, stoppedAt: -Infinity };
  trackLiveGrid(downbeatAt, since);
}

export function metronomeStopped() {
  if (metro.running) metro = { ...metro, running: false, stoppedAt: performance.now() };
  liveGrid = null;
  if (snap.liveSync) update({ liveSync: false });
}

// ── Live sync (the note views follow the metronome without recording) ─────────

export interface LiveGrid {
  meter: Meter;    // downbeatMs is performance.now() ms of bar 1, in the detected-note timebase
  since: number;   // identifies this grid: a tempo / metre change starts a new one, at bar 1
}

let liveGrid: LiveGrid | null = null;

function trackLiveGrid(downbeatAt: number, since: number) {
  const at = downbeatAt + ONSET_LAG_MS;
  if (liveGrid?.since !== since) {
    const m: Meter = { bpm: tempo.bpm, num: tempo.timeSig[0], den: tempo.timeSig[1], downbeatMs: at };
    const bars = Math.floor((since + ONSET_LAG_MS - at + 5) / barMs(m));
    liveGrid = { since, meter: { ...m, downbeatMs: at + bars * barMs(m) } };
    return;
  }
  // Click timestamps wobble by a few ms; ease towards them so the bar lines don't
  const m = liveGrid.meter;
  const bMs = barMs(m);
  const diff = at - m.downbeatMs;
  const off = diff - Math.round(diff / bMs) * bMs;
  liveGrid = { since, meter: { ...m, downbeatMs: m.downbeatMs + off * 0.1 } };
}

/** The grid to draw live notes on, or null when they run in free time. */
export const getLiveGrid = (): LiveGrid | null => (snap.liveSync && metro.running ? liveGrid : null);

const metronomeStartListeners = new Set<() => void>();

export function onMetronomeStart(fn: () => void) {
  metronomeStartListeners.add(fn);
  return () => { metronomeStartListeners.delete(fn); };
}

/** Sync needs clicks, so switching it on starts the metronome; stopping the metronome ends it. */
export function toggleLiveSync() {
  if (snap.liveSync) { update({ liveSync: false }); return; }
  update({ liveSync: true });
  metronomeStartListeners.forEach(fn => fn());
}

export interface MetronomeCue {
  bpm: number;
  timeSig: [number, number];
  startAt: number;   // performance.now() ms of the first (count-in) click
}

const cueListeners = new Set<(cue: MetronomeCue | null) => void>();

/** Guide playback asks the metronome to click along (null = stop the cued click). */
export function onMetronomeCue(fn: (cue: MetronomeCue | null) => void) {
  cueListeners.add(fn);
  return () => { cueListeners.delete(fn); };
}

let cued = false;
function cueMetronome(cue: MetronomeCue | null) {
  if (!cue && !cued) return;
  cued = !!cue;
  cueListeners.forEach(fn => fn(cue));
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
  const take: Take = {
    id: `take-${Date.now()}`,
    name: "Take",
    createdAt: Date.now(),
    bpm: tempo.bpm,
    timeSig: tempo.timeSig,
    durationMs: last.startMs + last.durMs,
    notes: out,
    sync: null,
  };

  // Clicking steadily through the whole take: keep its grid. Notes are stamped
  // ONSET_LAG_MS after the pick, so the grid is shifted by the same amount.
  const clicked = metro.since <= t0
    && (metro.running || metro.stoppedAt >= notes[notes.length - 1].start);
  if (clicked) {
    const m: Meter = {
      bpm: take.bpm, num: take.timeSig[0], den: take.timeSig[1],
      downbeatMs: metro.downbeatAt + ONSET_LAG_MS - t0,
    };
    take.sync = { downbeatMs: normalizeDownbeat(m, 0) };
  }
  return take;
}

// ── Sync editing (SONGS → TAKES) ──────────────────────────────────────────────

const firstStart = (take: Take) => take.notes[0]?.startMs ?? 0;

/** Tie a take to its BPM / time signature (first note on beat 1), or untie it. */
export function setTakeSynced(take: Take, on: boolean): Take {
  return { ...take, sync: on ? { downbeatMs: firstStart(take) } : null };
}

/** Change tempo / time signature, keeping the first note on the same beat. */
export function retimeTake(take: Take, bpm: number, timeSig: [number, number]): Take {
  const m = meterOf(take);
  if (!m) return { ...take, bpm, timeSig };
  const first = firstStart(take);
  const beatsIn = (first - m.downbeatMs) / (60000 / m.bpm);
  const next: Meter = { bpm, num: timeSig[0], den: timeSig[1], downbeatMs: first - beatsIn * (60000 / bpm) };
  return { ...take, bpm, timeSig, sync: { downbeatMs: normalizeDownbeat(next, first) } };
}

/** Move the bar lines so the first note lands `steps` 16ths later in the bar. */
export function nudgeTakeSync(take: Take, steps: number): Take {
  const m = meterOf(take);
  if (!m) return take;
  const sixteenth = (60000 / m.bpm) * (m.den / 16);
  const shifted = { ...m, downbeatMs: m.downbeatMs - steps * sixteenth };
  return { ...take, sync: { downbeatMs: normalizeDownbeat(shifted, firstStart(take)) } };
}

/** The count the first note falls on ("1", "2&" …), or "" for an unsynced take. */
export function takeFirstCount(take: Take): string {
  const m = meterOf(take);
  return m ? countAt(m, firstStart(take)) : "";
}

export const tempoLabel = (take: Take) =>
  `${take.timeSig[1] === 8 ? "♪" : "♩"}${Math.round(take.bpm)} ${take.timeSig[0]}/${take.timeSig[1]}`;

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
let guideSound = false;          // sound the guide's notes on a piano while it plays
let guideBase: Take | null = null;   // the guide as saved, before transposing
let transpose = 0;               // semitones the guide is moved, kept across loads

export const MAX_TRANSPOSE = 12;

/**
 * The take moved by `semis` semitones. Notes are re-fingered so tab still reads;
 * a note that falls off the neck keeps its pitch and loses its string / fret.
 * The id is kept, so the take still counts as the same one loaded from its song.
 */
function transposeTake(take: Take, semis: number): Take {
  if (!semis) return take;
  const fing = newFingeringState();
  return {
    ...take,
    notes: take.notes.map(n => {
      const midi = n.midi + semis;
      const f = assignFingering(midi, fing);
      return { ...n, midi, string: f?.string ?? null, fret: f?.fret ?? null };
    }),
  };
}

/** Show `take` as the guide, transposed. */
function setGuide(take: Take | null, patch: Partial<TakeSnapshot> = {}) {
  guideBase = take;
  update({ guide: take && transposeTake(take, transpose), ...patch });
}

export const getTranspose = (): number => transpose;

/** Move the guide up or down by `semis` semitones (also applies to guides loaded later). */
export function setGuideTranspose(semis: number) {
  const next = Math.max(-MAX_TRANSPOSE, Math.min(MAX_TRANSPOSE, Math.round(semis)));
  if (next === transpose) return;
  transpose = next;
  if (!guideBase) return;
  stopNotes();
  setGuide(guideBase);
  soundGuide();   // already-scheduled notes were at the old pitch
}

/** Schedule the guide's notes from now on, heard with the metronome (ONSET_LAG_MS before the line). */
function soundGuide() {
  const g = snap.guide;
  if (!g || !snap.guidePlaying || !guideSound) return;
  playNotes(g.notes.map(n => ({
    at: guideStartAt + n.startMs - ONSET_LAG_MS, durMs: n.durMs, midi: n.midi, velocity: n.velocity,
  })));
}

/** Turn the playback piano on or off, including mid-take. */
export function setGuideSound(on: boolean) {
  if (guideSound === on) return;
  guideSound = on;
  if (on) soundGuide(); else stopNotes();
}

function resetJudging() {
  judged = new Int8Array(snap.guide?.notes.length ?? 0).fill(-1);
  judgeFrom = 0;
}

/** Where a stopped guide sits: synced ones show bar 1 just past the play line. */
function restPosition(take: Take | null): number {
  const m = take && meterOf(take);
  return m ? m.downbeatMs - 60000 / m.bpm : -GUIDE_LEAD_MS;
}

export function loadGuide(take: Take) {
  cueMetronome(null);
  stopNotes();
  guidePausedAt = restPosition(take);
  setGuide(take, { guidePlaying: false });
  resetJudging();
}

export function unloadGuide() {
  cueMetronome(null);
  stopNotes();
  setGuide(null, { guidePlaying: false });
  resetJudging();
}

/** A saved take was edited: show the new version if it is the loaded guide. */
export function refreshGuide(take: Take) {
  if (snap.guide?.id !== take.id) return;
  if (snap.guidePlaying) stopGuide();
  guidePausedAt = restPosition(take);
  setGuide(take);
}

export function playGuide() {
  const g = snap.guide;
  if (!g) return;
  const now = performance.now();
  const m = meterOf(g);
  if (m) {
    // One bar of count-in before bar 1, heard ONSET_LAG_MS before the notes reach the line
    const countIn = m.downbeatMs - barMs(m);
    guideStartAt = now + Math.max(GUIDE_LEAD_MS, ONSET_LAG_MS + 150 - countIn);
    cueMetronome({ bpm: g.bpm, timeSig: g.timeSig, startAt: guideStartAt + countIn - ONSET_LAG_MS });
  } else {
    guideStartAt = now + GUIDE_LEAD_MS;
  }
  resetJudging();
  update({ guidePlaying: true });
  soundGuide();
}

export function stopGuide() {
  cueMetronome(null);
  stopNotes();
  guidePausedAt = restPosition(snap.guide);
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
    if (at - HIT_EARLY_MS > now) break;
    if (judged[i] === -1) {
      // Any matching live note sounding inside the window counts, including one
      // still held from earlier (re-picks of the same pitch can merge into it).
      for (let j = live.length - 1; j >= 0; j--) {
        const l = live[j];
        if ((l.end ?? now) < at - HIT_EARLY_MS) break;
        if (l.start <= at + HIT_LATE_MS && pitchMatches(l.midi, g.notes[i].midi)) { judged[i] = 1; break; }
      }
      if (judged[i] === -1 && now > at + HIT_LATE_MS) judged[i] = 0;
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

/** Synced takes are written with bar 1 on tick 0, so a DAW's bar lines match. */
export function takeToMidi(take: Take): Uint8Array {
  const m = meterOf(take);
  const shift = m ? m.downbeatMs : 0;
  return encodeMidi({
    name: take.name,
    bpm: (take.bpm * 4) / take.timeSig[1],
    timeSig: take.timeSig,
    program: GM_CLEAN_GUITAR,
    channels: [0, 1, 2, 3, 4, 5],
    texts: m ? [STRING_CHANNEL_TAG] : [STRING_CHANNEL_TAG, UNSYNCED_TAG],
    notes: take.notes.map(n => ({
      midi: n.midi, startMs: Math.max(0, n.startMs - shift), durMs: n.durMs, velocity: n.velocity,
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
  // MIDI files carry a grid (tick 0 = bar 1) unless we exported them unsynced
  const bpm = Math.round(((m.bpm * m.timeSig[1]) / 4) * 100) / 100;
  const meter: Meter = { bpm, num: m.timeSig[0], den: m.timeSig[1], downbeatMs: -t0 };
  return {
    id: `take-${Date.now()}`,
    name: m.name || fallbackName,
    createdAt: Date.now(),
    bpm,
    timeSig: m.timeSig,
    durationMs,
    notes,
    sync: m.texts.includes(UNSYNCED_TAG) ? null : { downbeatMs: normalizeDownbeat(meter, 0) },
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
