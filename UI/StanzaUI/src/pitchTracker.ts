/**
 * pitchTracker
 *
 * Single shared monophonic pitch tracker. Subscribes once to the serial audio
 * stream, runs YIN pitch detection and turns the result into discrete note
 * events (with onset / release detection and a guitar fingering per note).
 * Consumers poll the getters from their own draw loops.
 */

import { addChunkHandler } from "./useSerialStream";
import { assignFingering, freqToMidi, newFingeringState } from "./music";

export const SAMPLE_RATE = 47991;

const BUF_LEN   = 4096;
const WIN       = 1536;
const MIN_FREQ  = 78;     // just below low E (82.4 Hz)
const MAX_FREQ  = 1250;   // above D6, 22nd fret high e (1174.7 Hz)
const MAX_LAG   = Math.ceil(SAMPLE_RATE / MIN_FREQ);
const MIN_LAG   = Math.floor(SAMPLE_RATE / MAX_FREQ);
const HOP       = 512;
const RMS_LEN   = 1024;

const YIN_THRESHOLD   = 0.15;
const MIN_CLARITY     = 0.8;
const STABLE_FRAMES   = 3;    // consecutive frames a new pitch must hold before it becomes a note
const RELEASE_FRAMES  = 3;    // consecutive unvoiced frames before a note ends
const HOLD_SEMITONES  = 0.7;  // vibrato / bend tolerance around the active note
const ONSET_RATIO     = 1.8;
const ONSET_COOLDOWN  = 4;
const ONSET_TTL       = 10;
const RELEASE_RATIO   = 0.05; // note ends when level drops below this fraction of its peak
const MAX_NOTES       = 400;

export interface NoteEvent {
  id: number;
  midi: number;
  start: number;          // performance.now() ms
  end: number | null;     // null while still sounding
  string: number | null;  // 0 = low E … 5 = high e
  fret: number | null;
}

export interface PitchFrame {
  time: number;
  voiced: boolean;
  freq: number;
  midi: number;     // fractional MIDI note, NaN when unvoiced
  clarity: number;
  rms: number;
}

// ── State ─────────────────────────────────────────────────────────────────────

const buf  = new Float32Array(BUF_LEN);
const diff = new Float32Array(MAX_LAG + 1);
let pending = 0;

const frame: PitchFrame = { time: 0, voiced: false, freq: 0, midi: NaN, clarity: 0, rms: 0 };

let notes: NoteEvent[] = [];
let active: NoteEvent | null = null;
let lastNote: NoteEvent | null = null;
let nextId = 1;
let epoch = 0;

let candMidi = -1, candFrames = 0, candSince = 0;
let unvoicedFrames = 0;
let lastVoicedTime = 0;
let activePeakRms = 0;
let onsetPending = 0;
let onsetCooldown = 0;
const rmsHist = [0, 0, 0];
let noiseFloor = 0.002;

let fingering = newFingeringState();
let started = false;

// ── YIN ───────────────────────────────────────────────────────────────────────

let yinFreq = 0, yinClarity = 0;

function yin() {
  const start = BUF_LEN - WIN - MAX_LAG;
  diff[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= MAX_LAG; tau++) {
    let s = 0;
    const o = start + tau;
    for (let j = 0; j < WIN; j++) {
      const d = buf[start + j] - buf[o + j];
      s += d * d;
    }
    running += s;
    diff[tau] = running > 0 ? (s * tau) / running : 1;
  }

  let tau = -1;
  for (let t = MIN_LAG; t < MAX_LAG; t++) {
    if (diff[t] < YIN_THRESHOLD) {
      while (t + 1 < MAX_LAG && diff[t + 1] < diff[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    let best = Infinity;
    for (let t = MIN_LAG; t < MAX_LAG; t++) if (diff[t] < best) { best = diff[t]; tau = t; }
  }

  let refined = tau;
  const a = diff[tau - 1], b = diff[tau], c = diff[tau + 1];
  const den = a - 2 * b + c;
  if (den > 0) refined = tau + (0.5 * (a - c)) / den;

  yinFreq = SAMPLE_RATE / refined;
  yinClarity = 1 - b;
}

// ── Note events ───────────────────────────────────────────────────────────────

function endActive(t: number) {
  if (!active) return;
  active.end = Math.max(t, active.start + 30);
  active = null;
}

function startNote(midi: number, t: number, rms: number) {
  const f = assignFingering(midi, fingering);
  const n: NoteEvent = {
    id: nextId++, midi, start: t, end: null,
    string: f?.string ?? null, fret: f?.fret ?? null,
  };
  notes.push(n);
  if (notes.length > MAX_NOTES) notes = notes.slice(-MAX_NOTES);
  active = n;
  lastNote = n;
  activePeakRms = rms;
  unvoicedFrames = 0;
}

function analyse() {
  const now = performance.now();

  let e = 0;
  for (let i = BUF_LEN - RMS_LEN; i < BUF_LEN; i++) e += buf[i] * buf[i];
  const rms = Math.sqrt(e / RMS_LEN);

  noiseFloor = rms < noiseFloor ? noiseFloor * 0.7 + rms * 0.3 : Math.min(noiseFloor * 1.003, 0.05);
  noiseFloor = Math.max(noiseFloor, 1e-4);
  const gate = Math.max(0.0025, noiseFloor * 2.5);

  let freq = 0, clarity = 0;
  if (rms > gate) { yin(); freq = yinFreq; clarity = yinClarity; }
  const voiced = rms > gate && clarity >= MIN_CLARITY && freq >= MIN_FREQ && freq <= MAX_FREQ;
  const midiF = voiced ? freqToMidi(freq) : NaN;

  frame.time = now; frame.voiced = voiced; frame.freq = freq;
  frame.midi = midiF; frame.clarity = clarity; frame.rms = rms;

  // Onset: sharp level rise relative to the last few frames (catches re-picks of the same note)
  const minPrev = Math.min(rmsHist[0], rmsHist[1], rmsHist[2]);
  if (onsetCooldown > 0) onsetCooldown--;
  else if (rms > gate * 2 && rms > minPrev * ONSET_RATIO) {
    onsetPending = ONSET_TTL;
    onsetCooldown = ONSET_COOLDOWN;
    candMidi = -1; candFrames = 0;
  }
  rmsHist.shift(); rmsHist.push(rms);

  if (active) {
    activePeakRms = Math.max(activePeakRms, rms);
    if (!voiced || rms < activePeakRms * RELEASE_RATIO) {
      if (++unvoicedFrames >= RELEASE_FRAMES) endActive(lastVoicedTime);
    } else {
      unvoicedFrames = 0;
    }
  }

  if (voiced) {
    lastVoicedTime = now;
    const holding = active && onsetPending === 0 && Math.abs(midiF - active.midi) < HOLD_SEMITONES;
    if (holding) {
      candMidi = -1; candFrames = 0;
    } else {
      const m = Math.round(midiF);
      if (m === candMidi) candFrames++;
      else { candMidi = m; candFrames = 1; candSince = now; }

      if (candFrames >= STABLE_FRAMES) {
        if (!(active && onsetPending === 0 && m === active.midi)) {
          endActive(candSince);
          startNote(m, candSince, rms);
        }
        onsetPending = 0;
        candMidi = -1; candFrames = 0;
      }
    }
  }

  if (onsetPending > 0) onsetPending--;
}

function ingest(samples: number[]) {
  const len = samples.length;
  if (len >= BUF_LEN) buf.set(samples.slice(len - BUF_LEN));
  else { buf.copyWithin(0, len); buf.set(samples, BUF_LEN - len); }
  pending += len;
  if (pending >= HOP) { pending = 0; analyse(); }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startPitchTracker() {
  if (started) return;
  started = true;
  addChunkHandler(ingest);
}

export function resetPitchTracker() {
  buf.fill(0);
  pending = 0;
  notes = [];
  active = null;
  lastNote = null;
  candMidi = -1; candFrames = 0;
  unvoicedFrames = 0;
  onsetPending = 0;
  fingering = newFingeringState();
  frame.voiced = false; frame.midi = NaN; frame.freq = 0; frame.rms = 0; frame.clarity = 0;
  epoch++;
}

export const getPitchFrame = (): Readonly<PitchFrame> => frame;
export const getNotes = (): readonly NoteEvent[] => notes;
export const getActiveNote = (): NoteEvent | null => active;
export const getLastNote = (): NoteEvent | null => lastNote;
/** Increments on every reset so views can drop cached layout. */
export const getTrackerEpoch = (): number => epoch;
