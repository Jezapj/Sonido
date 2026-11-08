/**
 * rhythm
 *
 * Notation for takes tied to the metronome. Note times are snapped to a grid
 * of 16ths (or 8th-note triplets, where a beat's onsets clearly fit those
 * better), then spelled bar by bar as note values and rests, with dots, ties
 * across beats / bar lines, beam groups and triplet brackets.
 * Positions are in ticks, 12 per quarter note, so 16ths (3) and triplet 8ths
 * (4) are both whole numbers.
 */

export const TPQ = 12;
const SIXTEENTH = 3;
const TRIPLET_8TH = 4;

export interface Meter {
  bpm: number;        // metronome clicks per minute; one click per 1/den note
  num: number;
  den: number;
  downbeatMs: number; // take time of bar 1, beat 1
}

export const beatTicks = (m: Meter) => (TPQ * 4) / m.den;
export const barTicks = (m: Meter) => m.num * beatTicks(m);
export const tickMs = (m: Meter) => 60000 / m.bpm / beatTicks(m);
export const barMs = (m: Meter) => barTicks(m) * tickMs(m);

const isCompound = (m: Meter) => m.den === 8 && m.num % 3 === 0;
/** The felt pulse: a beat, or a dotted quarter in compound time. */
export const pulseTicks = (m: Meter) => (isCompound(m) ? 18 : beatTicks(m));
/** Beaming / beat group: a beat in x/4, a dotted quarter in 6/8 etc., pairs of 8ths otherwise. */
const groupTicks = (m: Meter) => (isCompound(m) ? 18 : TPQ);

const snap = (t: number, grid: number) => Math.round(t / grid) * grid;

/** Shift the downbeat by whole bars so `firstStartMs` lands in bar 1
 *  (a note a hair ahead of a downbeat counts as on it). */
export function normalizeDownbeat(m: Meter, firstStartMs: number): number {
  const bMs = barMs(m);
  const k = Math.floor((firstStartMs - m.downbeatMs + 1.5 * tickMs(m)) / bMs);
  return m.downbeatMs + k * bMs;
}

/** Where `ms` falls in its bar as a count: "1", "2&", "3e", "4a". */
export function countAt(m: Meter, ms: number): string {
  const bt = barTicks(m), b = beatTicks(m);
  const t = ((snap((ms - m.downbeatMs) / tickMs(m), SIXTEENTH) % bt) + bt) % bt;
  const subs = b === TPQ ? ["", "e", "&", "a"] : ["", "&"];
  return `${Math.floor(t / b) + 1}${subs[(t % b) / SIXTEENTH] ?? ""}`;
}

// ── Quantising ────────────────────────────────────────────────────────────────

export interface TimedNote { startMs: number; durMs: number; }
export interface QNote { note: number; start: number; end: number; }

/** Snap onsets and releases to the grid (ticks from bar 1). One note per onset. */
export function quantize(notes: readonly TimedNote[], m: Meter): { notes: QNote[]; triplet: Set<number> } {
  const tMs = tickMs(m);
  const raw = notes.map((n, i) => ({
    i,
    s: (n.startMs - m.downbeatMs) / tMs,
    e: (n.startMs + n.durMs - m.downbeatMs) / tMs,
    d: n.durMs,
  }));

  // Per quarter: straight 16ths, or 8th triplets when they fit the onsets clearly better
  const triplet = new Set<number>();
  if (m.den === 4) {
    const byQuarter = new Map<number, number[]>();
    for (const r of raw) {
      const q = Math.floor(snap(r.s, SIXTEENTH) / TPQ);
      const list = byQuarter.get(q);
      if (list) list.push(r.s); else byQuarter.set(q, [r.s]);
    }
    for (const [q, ss] of byQuarter) {
      if (ss.length < 2) continue;
      let straight = 0, trip = 0;
      for (const s of ss) { straight += (s - snap(s, SIXTEENTH)) ** 2; trip += (s - snap(s, TRIPLET_8TH)) ** 2; }
      if (trip < straight * 0.5) triplet.add(q);
    }
  }
  const gridAt = (t: number) => (triplet.has(Math.floor(snap(t, SIXTEENTH) / TPQ)) ? TRIPLET_8TH : SIXTEENTH);

  const snapped = raw
    .map(r => ({ note: r.i, start: Math.max(0, snap(r.s, gridAt(r.s))), end: snap(r.e, gridAt(r.e)), d: r.d }))
    .sort((a, b) => a.start - b.start);

  // The tracker is monophonic: two notes on one onset are a slide / re-trigger blip, keep the longer
  const kept: typeof snapped = [];
  for (const n of snapped) {
    const prev = kept[kept.length - 1];
    if (prev && prev.start === n.start) { if (n.d > prev.d) kept[kept.length - 1] = n; continue; }
    kept.push(n);
  }

  const beat = beatTicks(m);
  const pulse = pulseTicks(m);
  const out: QNote[] = [];
  for (let k = 0; k < kept.length; k++) {
    const n = kept[k];
    const next = kept[k + 1]?.start ?? Infinity;
    const rawEnd = raw[n.note].e;
    // Releases into a rest are loose: a note held a pulse or more ends on a pulse
    const coarse = rawEnd - raw[n.note].s >= pulse && next - rawEnd >= pulse;
    let end = Math.max(coarse ? Math.max(snap(rawEnd, pulse), n.start + pulse) : n.end, n.start + gridAt(n.start));
    // Overlaps end at the next note; short gaps (a grid step, or a quarter of the
    // spacing up to half a beat) are the note decaying early rather than a written rest
    const legato = Math.max(TRIPLET_8TH, Math.min((next - n.start) * 0.25, beat / 2));
    if (next < Infinity && next - end <= legato) end = next;
    out.push({ note: n.note, start: n.start, end });
  }
  return { notes: out, triplet };
}

// ── Spelling ──────────────────────────────────────────────────────────────────

export type NoteValue = "breve" | "whole" | "half" | "quarter" | "eighth" | "sixteenth";

export interface Glyph {
  tick: number;
  dur: number;
  note: number;          // index into the take's notes, -1 for a rest
  value: NoteValue;
  dots: number;
  triplet: boolean;
  tieToNext: boolean;
  tieFromPrev: boolean;
  beam: number;          // index into Score.beams, -1 when flagged / unbeamed
  barRest: boolean;      // whole-bar rest (drawn centred in the bar)
}

export interface Score {
  barTicks: number;
  bars: number;
  glyphs: Glyph[];
  beams: number[][];                          // glyph indices per beam group
  tuplets: { start: number; end: number }[];  // triplet quarters (ticks)
  notes: QNote[];
}

interface Value { len: number; value: NoteValue; dots: number; triplet: boolean; }

const VALUES: Value[] = [
  { len: 96, value: "breve",     dots: 0, triplet: false },
  { len: 72, value: "whole",     dots: 1, triplet: false },
  { len: 48, value: "whole",     dots: 0, triplet: false },
  { len: 36, value: "half",      dots: 1, triplet: false },
  { len: 24, value: "half",      dots: 0, triplet: false },
  { len: 18, value: "quarter",   dots: 1, triplet: false },
  { len: 12, value: "quarter",   dots: 0, triplet: false },
  { len: 9,  value: "eighth",    dots: 1, triplet: false },
  { len: 8,  value: "quarter",   dots: 0, triplet: true },
  { len: 6,  value: "eighth",    dots: 0, triplet: false },
  { len: 4,  value: "eighth",    dots: 0, triplet: true },
  { len: 3,  value: "sixteenth", dots: 0, triplet: false },
];

/**
 * Can value `v` start at global tick `a`? Keeps the beat visible: short values
 * stay inside their beat group, long ones start on a beat, nothing but the
 * first note crosses the middle of a 4/4 (or 12/8) bar, and triplet quarters
 * hold only triplet values unless covered whole.
 */
function fits(m: Meter, a: number, v: Value, isTrip: (q: number) => boolean): boolean {
  const T = barTicks(m), G = groupTicks(m);
  const p = a % T;
  const b = a + v.len;
  const q0 = Math.floor(a / TPQ), q1 = Math.ceil(b / TPQ) - 1;

  if (v.triplet) return isTrip(q0) && q0 === q1 && (a % TPQ) % TRIPLET_8TH === 0;
  for (let q = q0; q <= q1; q++) if (isTrip(q) && (a > q * TPQ || b < (q + 1) * TPQ)) return false;

  if (v.len < G) {
    if (Math.floor(p / G) !== Math.floor((p + v.len - 1) / G)) return false;
    const inG = p % G;
    if (v.len === 9) return inG === 0 || (!isCompound(m) && inG === SIXTEENTH);
    if (v.len === 12) return inG === 0 || inG === 6;   // compound: quarter + 8th, or 8th + quarter
    return inG % v.len === 0;
  }
  if (p % G) return false;
  if (isCompound(m) && v.len % G) return false;       // compound long values are dotted
  const mid = T / 2;
  if (T / G === 4 && p !== 0 && p < mid && p + v.len > mid) return false;
  return true;
}

/** `until` (ticks) is for music still being played: rests stop there instead of
 *  filling out the last bar, and the bar in progress counts as a bar. */
export function buildScore(notes: readonly TimedNote[], m: Meter, until?: number): Score {
  const T = barTicks(m), G = groupTicks(m);
  const { notes: q, triplet } = quantize(notes, m);
  const isTrip = (quarter: number) => triplet.has(quarter);
  const lastEnd = q.length ? q[q.length - 1].end : T;
  const bars = until === undefined
    ? Math.max(1, Math.ceil(lastEnd / T))
    : Math.max(1, Math.floor(until / T) + 1);
  const glyphs: Glyph[] = [];

  const spell = (from: number, to: number, note: number) => {
    const first = glyphs.length;
    let a = from;
    while (a < to) {
      const barEnd = (Math.floor(a / T) + 1) * T;
      const end = Math.min(to, barEnd);
      if (note < 0 && a % T === 0 && end === barEnd) {
        glyphs.push({
          tick: a, dur: T, note, value: "whole", dots: 0, triplet: false,
          tieToNext: false, tieFromPrev: false, beam: -1, barRest: true,
        });
        a = end;
        continue;
      }
      const v = VALUES.find(v => a + v.len <= end && fits(m, a, v, isTrip))
        ?? { len: Math.max(1, Math.min(end - a, SIXTEENTH)), value: "sixteenth" as const, dots: 0, triplet: false };
      glyphs.push({
        tick: a, dur: v.len, note, value: v.value, dots: v.dots, triplet: v.triplet,
        tieToNext: false, tieFromPrev: false, beam: -1, barRest: false,
      });
      a += v.len;
    }
    if (note >= 0) {
      for (let i = first; i < glyphs.length; i++) {
        glyphs[i].tieFromPrev = i > first;
        glyphs[i].tieToNext = i < glyphs.length - 1;
      }
    }
  };

  let at = 0;
  for (const n of q) {
    if (n.start > at) spell(at, n.start, -1);
    spell(n.start, n.end, n.note);
    at = n.end;
  }
  const restsTo = until ?? bars * T;
  if (at < restsTo) spell(at, restsTo, -1);

  // Beam runs of 8ths / 16ths inside one beat group; rests break a beam
  const beams: number[][] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 1) { for (const i of run) glyphs[i].beam = beams.length; beams.push(run); }
    run = [];
  };
  for (let i = 0; i < glyphs.length; i++) {
    const gl = glyphs[i];
    const beamable = gl.note >= 0 && (gl.value === "eighth" || gl.value === "sixteenth");
    const prev = run.length ? glyphs[run[run.length - 1]] : null;
    const group = (t: number) => Math.floor((t % T) / G) + Math.floor(t / T) * 1000;
    if (!beamable || (prev && group(prev.tick) !== group(gl.tick))) flush();
    if (beamable) run.push(i);
  }
  flush();

  const tuplets: { start: number; end: number }[] = [];
  for (const quarter of [...triplet].sort((a, b) => a - b)) {
    const start = quarter * TPQ, end = start + TPQ;
    if (glyphs.some(gl => gl.triplet && gl.tick >= start && gl.tick < end)) tuplets.push({ start, end });
  }

  return { barTicks: T, bars, glyphs, beams, tuplets, notes: q };
}
