/**
 * chordTracker
 *
 * Polyphonic companion to pitchTracker. YIN follows one note at a time, so a
 * strum leaves it unvoiced; this listens to the same audio stream and names
 * what is ringing as a chord instead.
 *
 * Each hop it takes a long FFT, picks the spectral peaks and folds them onto
 * the 12 pitch classes (a chroma). That profile is scored against a template
 * for every root and chord type, where each template already includes the
 * overtones a real string adds to the fifth and major third above it.
 *
 *   - Open-ended naming (`getChordFrame().chord`, chord events) picks the best
 *     template in CHORD_QUALITIES.
 *   - `matchChord(target)` checks one expected chord, which is far more
 *     forgiving and also reports which of its notes are heard.
 *
 * Consumers poll the getters from their own draw loops.
 */

import { addChunkHandler } from "./useSerialStream";
import { SAMPLE_RATE } from "./pitchTracker";
import { CHORD_QUALITIES, chordName, type ParsedChord } from "./chords";

const FFT_BITS  = 13;
const FFT_LEN   = 1 << FFT_BITS;   // 8192 samples ≈ 171 ms, 5.9 Hz per bin
const HOP       = 1024;            // ≈ 21 ms between frames
const RMS_LEN   = 1024;
const MIN_FREQ  = 70;              // below low E, room for drop D
const MAX_FREQ  = 2000;
const ROLLOFF_HZ = 600;            // partials above this count for less: mostly overtones up there
const PEAK_FLOOR = 0.03;           // ignore partials weaker than this share of the strongest

/** Share of a note's level that its 3rd / 6th harmonics put on the fifth above it. */
const HARMONIC_FIFTH = 0.3;
/** Same for the 5th harmonic and the major third above. */
const HARMONIC_THIRD = 0.1;

const NOTE_PRESENT   = 0.25;  // a pitch class counts as sounding above this share of the strongest
const MIN_NOTE_HZ    = 75;    // lowest fundamental a string could be playing
const MONO_SHARE     = 0.9;   // partials on one harmonic series, by level, for the sound to be a single note
const SERIES_CENTS   = 45;    // how far a partial may sit from a whole multiple and still belong to the series
const FIFTH_WEIGHT   = 0.6;   // template weight of the fifth in four-note chords, where voicings often drop it
const CHORD_MIN_SCORE = 0.8;  // template similarity needed before a chord is named
const BASS_BONUS     = 0.04;  // nudge towards the chord rooted on the lowest note
const NOTE_COST      = 0.03;  // score lost per chord note not heard, and per heard note outside the chord
const HOLD_MARGIN    = 0.03;  // the active chord keeps its name unless another beats it by this much
const STABLE_FRAMES  = 4;     // consecutive frames a new chord must hold before it becomes an event
const SWITCH_FRAMES  = 12;    // …or this many to rename a ringing chord with no new strum
const SETTLE_FRAMES  = 5;     // frames after a strum before naming starts: the strings arrive one by one
const RELEASE_FRAMES = 6;     // consecutive chordless frames before the active chord ends
const RELEASE_RATIO  = 0.04;  // …or once the level drops below this fraction of its peak
const ONSET_BITS     = 11;
const ONSET_LEN      = 1 << ONSET_BITS;   // short window for strum detection, ≈ 43 ms
const ONSET_MAX_HZ   = 6000;
const FLUX_FLOOR     = 0.05;  // partials below this share of the current level do not count towards it
const FLUX_MIN       = 0.025;  // mean rise in log level across the spectrum that counts as a strum…
const FLUX_RATIO     = 3;     // …and it must stand this far above the recent norm
const ONSET_COOLDOWN = 5;
const ONSET_TTL      = 14;
const MAX_CHORDS     = 200;

const MATCH_MIN_SCORE = 0.72;  // an expected chord must fit at least this well…
const MATCH_MARGIN    = 0.08;  // …and come within this of the best-fitting chord of any kind
const OPTIONAL_WEIGHT = 0.5;   // template weight of tones a voicing may leave out
const TONE_HEARD      = 0.12;  // an expected note counts as heard above this share of the strongest
const FOREIGN_NOTE    = 0.45;  // a note outside the expected chord this strong rules the chord out…
const FOREIGN_BASS    = 0.25;  // …or this strong when it is the lowest note sounding
const THIRD_IN_POWER  = 0.3;   // a third this strong means a full chord was played where a power chord was asked for

export interface ChordCandidate {
  root: number;            // pitch class, 0 = C
  suffix: string;          // "", "m", "7", …
  name: string;
  pitchClasses: number[];
  score: number;           // template similarity, 0..1
}

export interface ChordFrame {
  time: number;            // performance.now() ms
  rms: number;
  sounding: boolean;       // above the noise gate
  chroma: Float32Array;    // energy per pitch class, strongest = 1
  notes: Float32Array;     // chroma with each note's overtones removed, strongest = 1
  noteCount: number;       // pitch classes sounding in `notes`
  bass: number;            // pitch class of the lowest strong partial, -1 when silent
  chord: ChordCandidate | null;   // best name for this frame; null when silent, a single note, or unclear
  fit: number;             // similarity to the best-fitting chord of any kind, before naming rules
  onsetSeq: number;        // increments on every strum
  onsetTime: number;
}

export interface ChordEvent {
  id: number;
  root: number;
  suffix: string;
  name: string;
  pitchClasses: number[];
  start: number;           // performance.now() ms
  end: number | null;      // null while still ringing
  confidence: number;      // best template similarity while ringing
  peak: number;            // peak RMS while ringing
}

export interface ChordMatch {
  match: boolean;
  score: number;           // how well the sound fits the expected chord, 0..1
  tones: { pc: number; required: boolean; heard: boolean }[];
}

// ── FFT ───────────────────────────────────────────────────────────────────────

const HANN = new Float32Array(FFT_LEN);
const COS  = new Float32Array(FFT_LEN / 2);
const SIN  = new Float32Array(FFT_LEN / 2);
for (let i = 0; i < FFT_LEN; i++) HANN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_LEN - 1)));
for (let i = 0; i < FFT_LEN / 2; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / FFT_LEN);
  SIN[i] = Math.sin((2 * Math.PI * i) / FFT_LEN);
}

function bitReversal(bits: number): Uint16Array {
  const n = 1 << bits;
  const rev = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  return rev;
}
const REV = bitReversal(FFT_BITS);
const REV_ONSET = bitReversal(ONSET_BITS);

const re = new Float32Array(FFT_LEN);
const im = new Float32Array(FFT_LEN);

/** In-place radix-2 FFT of the first `n` entries of `re` / `im`, already in bit-reversed order. */
function fft(n: number) {
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = FFT_LEN / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = COS[k], wi = -SIN[k];
        const a = i + j, b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr;        im[a] += ti;
      }
    }
  }
}

// ── Templates ─────────────────────────────────────────────────────────────────

/** Spread note weights (12 pitch classes) by the overtone model and scale to unit length. */
function buildTemplate(noteWeights: ArrayLike<number>, out: Float32Array, at = 0) {
  let norm = 0;
  for (let pc = 0; pc < 12; pc++) {
    const v = noteWeights[pc]
      + HARMONIC_FIFTH * noteWeights[(pc + 5) % 12]    // overtone of the note a fifth below
      + HARMONIC_THIRD * noteWeights[(pc + 8) % 12];   // overtone of the note a major third below
    out[at + pc] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  for (let pc = 0; pc < 12; pc++) out[at + pc] /= norm;
}

const QUALITY_COUNT = CHORD_QUALITIES.length;
const TEMPLATE_COUNT = QUALITY_COUNT * 12;       // index = quality * 12 + root
const templates = new Float32Array(TEMPLATE_COUNT * 12);
const templateMask = new Uint16Array(TEMPLATE_COUNT);    // one bit per pitch class in the chord
const templateFifth = new Uint16Array(TEMPLATE_COUNT);   // the bit of its perfect fifth, if it has one
{
  const w = new Float32Array(12);
  for (let q = 0; q < QUALITY_COUNT; q++) {
    for (let root = 0; root < 12; root++) {
      w.fill(0);
      const ivs = CHORD_QUALITIES[q].intervals;
      for (const iv of ivs) {
        w[(root + iv) % 12] = iv === 7 && ivs.length > 3 ? FIFTH_WEIGHT : 1;
        templateMask[q * 12 + root] |= 1 << ((root + iv) % 12);
        if (iv === 7) templateFifth[q * 12 + root] = 1 << ((root + iv) % 12);
      }
      buildTemplate(w, templates, (q * 12 + root) * 12);
    }
  }
}

const targetTemplates = new Map<string, Float32Array>();

function targetTemplate(target: ParsedChord): Float32Array {
  let t = targetTemplates.get(target.symbol);
  if (!t) {
    const w = new Float32Array(12);
    for (const tone of target.tones) w[tone.pc] = tone.required ? 1 : OPTIONAL_WEIGHT;
    t = new Float32Array(12);
    buildTemplate(w, t);
    if (targetTemplates.size > 500) targetTemplates.clear();
    targetTemplates.set(target.symbol, t);
  }
  return t;
}

// Overtone removal: chroma ≈ H · notes, with H the circulant overtone model above.
// G = HᵀH is circulant too, so one row of it is all the solver needs.
const OVERTONE = new Float32Array(12);
OVERTONE[0] = 1; OVERTONE[7] = HARMONIC_FIFTH; OVERTONE[4] = HARMONIC_THIRD;
const GRAM = new Float32Array(12);
for (let d = 0; d < 12; d++) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += OVERTONE[i] * OVERTONE[(i + d) % 12];
  GRAM[d] = s;
}
const htc = new Float32Array(12);

/** Non-negative least squares by multiplicative updates. `out` ends up holding the notes. */
function removeOvertones(chroma: Float32Array, out: Float32Array) {
  for (let j = 0; j < 12; j++) {
    htc[j] = chroma[j] + HARMONIC_FIFTH * chroma[(j + 7) % 12] + HARMONIC_THIRD * chroma[(j + 4) % 12];
    out[j] = chroma[j];
  }
  for (let it = 0; it < 40; it++) {
    for (let j = 0; j < 12; j++) {
      let den = 1e-9;
      for (let k = 0; k < 12; k++) den += GRAM[(j - k + 12) % 12] * out[k];
      out[j] *= htc[j] / den;
    }
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

const buf = new Float32Array(FFT_LEN);
let pending = 0;

const KMIN = Math.max(2, Math.floor((MIN_FREQ * FFT_LEN) / SAMPLE_RATE));
const KMAX = Math.min(FFT_LEN / 2 - 2, Math.ceil((MAX_FREQ * FFT_LEN) / SAMPLE_RATE));
const mags = new Float32Array(KMAX + 2);
const PEAK_MAX = 128;
const peakFreq = new Float32Array(PEAK_MAX);
const peakMag = new Float32Array(PEAK_MAX);
let peakCount = 0;
let peakTop = 0;
let bassFreq = 0;

const frame: ChordFrame = {
  time: 0, rms: 0, sounding: false,
  chroma: new Float32Array(12), notes: new Float32Array(12),
  noteCount: 0, bass: -1, chord: null, fit: 0, onsetSeq: 0, onsetTime: 0,
};
const unit = new Float32Array(12);                 // chroma at unit length, for scoring
const scores = new Float32Array(TEMPLATE_COUNT);   // adjusted score per template this frame

let chords: ChordEvent[] = [];
let active: ChordEvent | null = null;
let activeKey = -1;
let lastChord: ChordEvent | null = null;
let nextId = 1;

let candKey = -1, candFrames = 0, candSince = 0;
let quietFrames = 0;
let activePeakRms = 0;
let onsetPending = 0;
let onsetCooldown = 0;
const ONSET_KMIN = Math.max(1, Math.floor((MIN_FREQ * ONSET_LEN) / SAMPLE_RATE));
const ONSET_KMAX = Math.min(ONSET_LEN / 2 - 1, Math.ceil((ONSET_MAX_HZ * ONSET_LEN) / SAMPLE_RATE));
const logSpec = [0, 1, 2].map(() => new Float32Array(ONSET_KMAX + 1));   // this hop and the two before
let fluxPhase = 0;
let levelBefore = 0;   // smoothed RMS, lagging the newest hop
const fluxHist = new Float32Array(6);
const fluxSorted = new Float32Array(6);
let noiseFloor = 0.002;

let users = 0;
let unsubscribe: (() => void) | null = null;

// ── Analysis ──────────────────────────────────────────────────────────────────

function clearFrame() {
  frame.chroma.fill(0);
  frame.notes.fill(0);
  frame.noteCount = 0;
  frame.bass = -1;
  frame.chord = null;
  frame.fit = 0;
}

/**
 * Spectral flux of the newest samples: how much the log spectrum rose since the last hop,
 * averaged over the bins. Level alone misses a strum over a chord that is still ringing,
 * since re-plucking a string barely changes how loud it is. The upper partials that had
 * died away coming back is what marks it.
 */
function spectralFlux(floor: number): number {
  const from = FFT_LEN - ONSET_LEN, stride = FFT_LEN / ONSET_LEN;
  for (let i = 0; i < ONSET_LEN; i++) {
    const r = REV_ONSET[i];
    re[r] = buf[from + i] * HANN[i * stride];
    im[r] = 0;
  }
  fft(ONSET_LEN);
  // Compared with two hops back, so a strum that takes 50 ms to cross the strings still reads
  // as one jump, and with the neighbouring bins, so vibrato and beating strings do not.
  const now = logSpec[fluxPhase], then = logSpec[(fluxPhase + 1) % 3];
  fluxPhase = (fluxPhase + 1) % 3;
  const scale = 4 / (ONSET_LEN * floor);
  let rise = 0;
  for (let k = ONSET_KMIN; k <= ONSET_KMAX; k++) {
    now[k] = Math.log(1 + Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale);
  }
  for (let k = ONSET_KMIN + 1; k < ONSET_KMAX; k++) {
    const ref = Math.max(then[k - 1], then[k], then[k + 1]);
    if (now[k] > ref) rise += now[k] - ref;
  }
  return rise / (ONSET_KMAX - ONSET_KMIN - 1);
}

/** Share of the partials' level that sits on whole multiples of `f0` (first ten harmonics). */
function seriesShare(f0: number): number {
  let on = 0, all = 0;
  for (let i = 0; i < peakCount; i++) {
    const r = peakFreq[i] / f0;
    if (r > 10.5) break;
    const n = Math.round(r);
    all += peakMag[i];
    if (n >= 1 && Math.abs(1200 * Math.log2(r / n)) <= SERIES_CENTS) on += peakMag[i];
  }
  return all > 0 ? on / all : 0;
}

function hasPartial(freq: number): boolean {
  for (let i = 0; i < peakCount; i++) {
    if (peakMag[i] >= peakTop * 0.1 && Math.abs(1200 * Math.log2(peakFreq[i] / freq)) <= SERIES_CENTS) return true;
  }
  return false;
}

/**
 * True when every partial belongs to one string. The lowest partial is normally the
 * fundamental; if the fundamental is too weak to register it is the 2nd harmonic, and then
 * the odd harmonics in between (5th, 7th) give the note away. A power chord or an A-shape
 * barre chord also lines up on a series an octave down, but has nothing at those two.
 */
function isSingleNote(): boolean {
  if (bassFreq <= 0) return false;
  if (seriesShare(bassFreq) >= MONO_SHARE) return true;
  const sub = bassFreq / 2;
  return sub >= MIN_NOTE_HZ && seriesShare(sub) >= MONO_SHARE && hasPartial(5 * sub) && hasPartial(7 * sub);
}

/** Fill `frame.chroma`, `frame.notes`, `frame.bass`. Returns false when nothing tonal is found. */
function spectrum(): boolean {
  for (let i = 0; i < FFT_LEN; i++) {
    const r = REV[i];
    re[r] = buf[i] * HANN[i];
    im[r] = 0;
  }
  fft(FFT_LEN);

  let maxMag = 0;
  for (let k = KMIN - 1; k <= KMAX + 1; k++) {
    const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    mags[k] = m;
    if (m > maxMag) maxMag = m;
  }
  if (maxMag <= 0) return false;

  const chroma = frame.chroma;
  chroma.fill(0);
  const floor = maxMag * PEAK_FLOOR;
  peakCount = 0;
  peakTop = 0;
  let lowMax = 0;
  for (let k = KMIN; k <= KMAX && peakCount < PEAK_MAX; k++) {
    const b = mags[k];
    if (b < floor || b <= mags[k - 1] || b < mags[k + 1]) continue;
    // Parabola through the log magnitudes: sub-bin frequency and the true peak height
    const la = Math.log(mags[k - 1] + 1e-12), lb = Math.log(b), lc = Math.log(mags[k + 1] + 1e-12);
    const den = la - 2 * lb + lc;
    const p = den < 0 ? (0.5 * (la - lc)) / den : 0;
    const freq = ((k + p) * SAMPLE_RATE) / FFT_LEN;
    const mag = Math.exp(lb - 0.25 * (la - lc) * p);
    peakFreq[peakCount] = freq;
    peakMag[peakCount++] = mag;
    if (mag > peakTop) peakTop = mag;
    if (freq < 500 && mag > lowMax) lowMax = mag;

    const midi = 69 + 12 * Math.log2(freq / 440);
    const nearest = Math.round(midi);
    const tune = Math.cos(Math.PI * (midi - nearest));   // 1 on pitch, 0 a quarter-tone out
    const weight = freq > ROLLOFF_HZ ? ROLLOFF_HZ / freq : 1;
    chroma[((nearest % 12) + 12) % 12] += mag * weight * tune * tune;
  }

  // Bass: the lowest partial that is a real share of the low end, not a stray rumble peak
  bassFreq = 0;
  for (let i = 0; i < peakCount; i++) {
    if (peakMag[i] >= lowMax * 0.3) { bassFreq = peakFreq[i]; break; }
  }
  frame.bass = bassFreq > 0 ? ((Math.round(69 + 12 * Math.log2(bassFreq / 440)) % 12) + 12) % 12 : -1;

  let top = 0, norm = 0;
  for (let pc = 0; pc < 12; pc++) {
    if (chroma[pc] > top) top = chroma[pc];
    norm += chroma[pc] * chroma[pc];
  }
  if (top <= 0) return false;
  norm = Math.sqrt(norm);
  for (let pc = 0; pc < 12; pc++) {
    unit[pc] = chroma[pc] / norm;
    chroma[pc] /= top;
  }

  const notes = frame.notes;
  removeOvertones(chroma, notes);
  let noteTop = 0;
  for (let pc = 0; pc < 12; pc++) if (notes[pc] > noteTop) noteTop = notes[pc];
  let count = 0;
  for (let pc = 0; pc < 12; pc++) {
    notes[pc] = noteTop > 0 ? notes[pc] / noteTop : 0;
    if (notes[pc] >= NOTE_PRESENT) count++;
  }
  // Folded onto pitch classes, one note and its overtones look like a root and a fifth.
  // The partials themselves tell the two apart.
  if (isSingleNote()) count = 1;
  else if (count < 2) count = 2;
  frame.noteCount = count;
  return true;
}

const bitCount = (v: number): number => {
  let n = 0;
  for (; v; v &= v - 1) n++;
  return n;
};

/**
 * Rank every template against this frame. Similarity to the chroma does most of the work;
 * the notes actually heard then separate chords that differ by one string, such as G and G7.
 * Returns the winning template index, or -1.
 */
function classify(): number {
  let heard = 0, heardRaw = 0;
  for (let pc = 0; pc < 12; pc++) {
    if (frame.notes[pc] >= TONE_HEARD) heard |= 1 << pc;
    if (frame.chroma[pc] >= TONE_HEARD) heardRaw |= 1 << pc;
  }

  let best = -1, bestScore = -Infinity, bestDot = 0;
  frame.fit = 0;
  for (let t = 0; t < TEMPLATE_COUNT; t++) {
    const at = t * 12;
    let dot = 0;
    for (let pc = 0; pc < 12; pc++) dot += unit[pc] * templates[at + pc];
    if (dot > frame.fit) frame.fit = dot;

    const quality = CHORD_QUALITIES[(t / 12) | 0];
    const mask = templateMask[t], fifth = templateFifth[t];
    // A power chord is only named from its root: upside down it is a fourth, part of many chords
    if (quality.intervals.length === 2 && frame.bass >= 0 && t % 12 !== frame.bass) {
      scores[t] = -1;
      continue;
    }
    // The fifth is judged on the raw profile: the root's overtones land on it either way
    const missing = bitCount(mask & ~fifth & ~heard) + (fifth && !(heardRaw & fifth) ? 1 : 0);
    const extra = bitCount(heard & ~mask);
    let s = dot - quality.penalty - NOTE_COST * (missing + extra);
    if (t % 12 === frame.bass) s += BASS_BONUS;
    scores[t] = s;
    if (s > bestScore) { bestScore = s; best = t; bestDot = dot; }
  }
  if (best < 0 || bestDot < CHORD_MIN_SCORE) return -1;
  if (frame.noteCount < 2) return -1;   // one string and its overtones

  const root = best % 12;
  const quality = CHORD_QUALITIES[(best / 12) | 0];
  const prev = frame.chord;
  if (!prev || prev.root !== root || prev.suffix !== quality.suffix) {
    frame.chord = {
      root, suffix: quality.suffix, name: chordName(root, quality.suffix),
      pitchClasses: quality.intervals.map(iv => (root + iv) % 12),
      score: bestDot,
    };
  } else {
    prev.score = bestDot;
  }
  return best;
}

function endActive(t: number) {
  if (!active) return;
  active.end = Math.max(t, active.start + 30);
  active = null;
  activeKey = -1;
}

function startChord(key: number, c: ChordCandidate, t: number, rms: number) {
  const ev: ChordEvent = {
    id: nextId++, root: c.root, suffix: c.suffix, name: c.name,
    pitchClasses: c.pitchClasses, start: t, end: null,
    confidence: c.score, peak: rms,
  };
  chords.push(ev);
  if (chords.length > MAX_CHORDS) chords = chords.slice(-MAX_CHORDS);
  active = ev;
  activeKey = key;
  lastChord = ev;
  activePeakRms = rms;
  quietFrames = 0;
}

function analyse(now: number) {
  let e = 0;
  for (let i = FFT_LEN - RMS_LEN; i < FFT_LEN; i++) e += buf[i] * buf[i];
  const rms = Math.sqrt(e / RMS_LEN);

  noiseFloor = rms < noiseFloor ? noiseFloor * 0.7 + rms * 0.3 : Math.min(noiseFloor * 1.003, 0.05);
  noiseFloor = Math.max(noiseFloor, 1e-4);
  const gate = Math.max(0.0025, noiseFloor * 2.5);
  const sounding = rms > gate;

  // Strum: the spectrum jumps well clear of how much it has been moving lately
  const flux = spectralFlux(Math.max(gate, levelBefore) * FLUX_FLOOR);
  levelBefore += (rms - levelBefore) * 0.3;
  fluxSorted.set(fluxHist);
  fluxSorted.sort();
  const usual = (fluxSorted[2] + fluxSorted[3]) / 2;
  if (onsetCooldown > 0) onsetCooldown--;
  else if (rms > gate * 2 && flux > Math.max(FLUX_MIN, usual * FLUX_RATIO)) {
    frame.onsetSeq++;
    frame.onsetTime = now;
    onsetPending = ONSET_TTL;
    onsetCooldown = ONSET_COOLDOWN;
    candKey = -1; candFrames = 0;
  }
  fluxHist.copyWithin(0, 1);
  fluxHist[fluxHist.length - 1] = flux;

  frame.time = now;
  frame.rms = rms;
  frame.sounding = sounding;

  let key = -1;
  if (sounding && spectrum()) {
    key = classify();
    if (key < 0) frame.chord = null;
  } else {
    clearFrame();
  }

  if (active) {
    activePeakRms = Math.max(activePeakRms, rms);
    active.peak = activePeakRms;
    if (key < 0 || rms < activePeakRms * RELEASE_RATIO) {
      if (++quietFrames >= RELEASE_FRAMES) endActive(now);
    } else {
      quietFrames = 0;
    }
  }

  if (key >= 0) {
    const c = frame.chord!;
    const holding = active !== null && onsetPending === 0
      && (key === activeKey || scores[activeKey] >= scores[key] - HOLD_MARGIN);
    if (onsetPending > ONSET_TTL - SETTLE_FRAMES) {
      candKey = -1; candFrames = 0;
    } else if (holding) {
      candKey = -1; candFrames = 0;
      if (key === activeKey && c.score > active!.confidence) active!.confidence = c.score;
    } else {
      if (key === candKey) candFrames++;
      else { candKey = key; candFrames = 1; candSince = now; }

      if (candFrames >= (active && onsetPending === 0 ? SWITCH_FRAMES : STABLE_FRAMES)) {
        if (!(active && onsetPending === 0 && key === activeKey)) {
          const start = now - frame.onsetTime < 500 ? Math.min(frame.onsetTime, candSince) : candSince;
          endActive(start);
          startChord(key, c, start, rms);
        }
        onsetPending = 0;
        candKey = -1; candFrames = 0;
      }
    }
  }

  if (onsetPending > 0) onsetPending--;
}

function ingest(samples: number[]) {
  const now = performance.now();
  const len = samples.length;
  let i = 0;
  while (i < len) {
    const n = Math.min(HOP - pending, len - i);
    buf.copyWithin(0, n);
    const at = FFT_LEN - n;
    for (let j = 0; j < n; j++) buf[at + j] = samples[i + j];
    i += n;
    pending += n;
    if (pending >= HOP) {
      pending = 0;
      analyse(now - ((len - i) / SAMPLE_RATE) * 1000);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start listening. Returns a function that stops again; the tracker only runs
 * (one long FFT per hop) while at least one caller is holding it open.
 */
export function startChordTracker(): () => void {
  if (users++ === 0) unsubscribe = addChunkHandler(ingest);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--users === 0) {
      unsubscribe?.();
      unsubscribe = null;
      resetChordTracker();
    }
  };
}

export function resetChordTracker() {
  buf.fill(0);
  pending = 0;
  chords = [];
  active = null;
  activeKey = -1;
  lastChord = null;
  candKey = -1; candFrames = 0;
  quietFrames = 0;
  onsetPending = 0;
  onsetCooldown = 0;
  logSpec.forEach(l => l.fill(0));
  levelBefore = 0;
  fluxHist.fill(0);
  frame.rms = 0;
  frame.sounding = false;
  clearFrame();
}

export const getChordFrame = (): Readonly<ChordFrame> => frame;
export const getChords = (): readonly ChordEvent[] => chords;
export const getActiveChord = (): ChordEvent | null => active;
export const getLastChord = (): ChordEvent | null => lastChord;

/**
 * Check the current frame against one expected chord. Knowing what should be
 * ringing makes this much more reliable than open-ended naming: the chord only
 * has to fit about as well as the best alternative, and every note it needs
 * has to be heard.
 */
export function matchChord(target: ParsedChord): ChordMatch {
  const live = frame.sounding && frame.noteCount > 0;
  let score = 0;
  if (live) {
    const t = targetTemplate(target);
    for (let pc = 0; pc < 12; pc++) score += unit[pc] * t[pc];
  }
  let complete = live;
  let hasThird = false;
  const tones = target.tones.map(tone => {
    // A perfect fifth cannot be told from the root's own overtone, so the raw profile decides
    const level = tone.interval === 7 ? frame.chroma[tone.pc] : frame.notes[tone.pc];
    const heard = live && level >= TONE_HEARD;
    if (tone.required && !heard) complete = false;
    if (tone.interval === 3 || tone.interval === 4) hasThird = true;
    return { pc: tone.pc, required: tone.required, heard };
  });
  if (complete) {
    // A loud note that has no place in the chord means something else was played. The bar is
    // lower for the bass note, which is what separates C from Am7 and Dm from Bbmaj7.
    let inChord = 0;
    for (const tone of target.tones) inChord |= 1 << tone.pc;
    for (let pc = 0; pc < 12; pc++) {
      if (inChord & (1 << pc)) continue;
      if (frame.notes[pc] >= (pc === frame.bass ? FOREIGN_BASS : FOREIGN_NOTE)) complete = false;
    }
  }
  if (complete && target.tones.length === 2 && !hasThird) {
    // Asked for a power chord: a clear third means a full major or minor chord was played
    const minor = frame.notes[(target.root + 3) % 12], major = frame.notes[(target.root + 4) % 12];
    if (Math.max(minor, major) >= THIRD_IN_POWER) complete = false;
  }
  return {
    match: complete && score >= MATCH_MIN_SCORE && score >= frame.fit - MATCH_MARGIN,
    score,
    tones,
  };
}
