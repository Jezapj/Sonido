/**
 * chordPractice
 *
 * Practice mode for the Chord Bank. Steps through a song's chords and waits at
 * each one until the chord tracker hears it played. Because the expected chord
 * is known, this uses matchChord() rather than open-ended naming: it is far
 * more reliable, and it can say which notes of the chord are not ringing.
 */

import { useEffect, useMemo, useState } from "react";
import { parseChord, pitchClassName, type ParsedChord } from "./chords";
import { getChordFrame, matchChord, startChordTracker } from "./chordTracker";

/** `clean`: right on the first strum. `retry`: right after at least one wrong chord. */
export type StepResult = "clean" | "retry";

const HIT_FRAMES    = 3;     // consecutive matching frames (≈ 65 ms) for a chord to count
const ARM_FRAMES    = 6;     // non-matching frames before a match may count without a fresh strum
const MISS_FRAMES   = 6;     // frames of some other chord before a strum is called wrong
const MISS_FROM_MS  = 200;   // …judged only once the strum has settled
const MISS_TO_MS    = 900;
const REARM_MS      = 180;   // a strum this soon after the one that counted is the same strum, still crossing the strings
const HEARD_HOLD_MS = 450;   // keep the heard chord on screen through brief dropouts
const SIGNAL_MS     = 600;

/**
 * One pass through a chord list. `step()` is called from a draw loop and reads
 * the chord tracker; everything else is plain state for the view to show.
 */
export class PracticeRun {
  /** Position of the chord to play now; equals `chords.length` once finished. */
  index = 0;
  /** Outcome per position. Replaced, never mutated, so a change is visible by identity. */
  results: (StepResult | undefined)[] = [];
  /** Which notes of the current chord are heard, one bit per entry of its `tones`. */
  toneBits = 0;
  /** Chord ringing now, as best the tracker can name it; empty when nothing is. */
  heard = "";
  /** The last strum was confidently some other chord. */
  wrong = false;
  /** Audio is arriving from the input. */
  signal = false;

  // A match only counts once "armed": after a fresh strum, or after the sound stopped
  // matching for a while. Otherwise one ringing G would tick off every G in a row.
  private armed = true;
  private onsetSeq = getChordFrame().onsetSeq;
  private strumGuard = 0;    // only strums after this tracker time are for the current chord
  private matchFrames = 0;
  private offFrames = 0;
  private missFrames = 0;
  private misses = 0;
  private judged = false;    // this strum has already been called wrong
  private lastHeard = "";
  private heardAt = 0;
  private frameTime = 0;

  constructor(readonly chords: readonly (ParsedChord | null)[]) {
    this.goTo(0, true);
  }

  get target(): ParsedChord | null {
    return this.chords[this.index] ?? null;
  }

  restart() {
    this.results = [];
    this.goTo(0, true);
  }

  jump(index: number) {
    if (!this.chords[index]) return;
    const results = this.results.slice();
    results[index] = undefined;
    this.results = results;
    this.goTo(index, true);
  }

  private goTo(index: number, armed: boolean, strumGuard = getChordFrame().time) {
    let i = index;
    while (i < this.chords.length && !this.chords[i]) i++;   // skip bar lines, `x2`, …
    this.index = i;
    this.armed = armed;
    this.strumGuard = strumGuard;
    this.matchFrames = 0;
    this.offFrames = 0;
    this.missFrames = 0;
    this.misses = 0;
    this.judged = false;
    this.wrong = false;
    this.toneBits = 0;
  }

  step(now: number) {
    const f = getChordFrame();
    this.signal = now - f.time < SIGNAL_MS;
    const target = this.target;

    if (target) {
      const m = matchChord(target);
      let bits = 0;
      m.tones.forEach((t, i) => { if (t.heard) bits |= 1 << i; });
      this.toneBits = bits;

      if (f.time !== this.frameTime) {
        this.frameTime = f.time;

        if (f.onsetSeq !== this.onsetSeq) {
          this.onsetSeq = f.onsetSeq;
          if (f.onsetTime > this.strumGuard) {
            this.armed = true;
            this.judged = false;
            this.missFrames = 0;
            this.wrong = false;
          }
        }

        if (m.match) {
          this.offFrames = 0;
          this.missFrames = 0;
          this.lastHeard = target.symbol;
          this.heardAt = now;
          if (this.armed) this.matchFrames++;
        } else {
          this.matchFrames = 0;
          // The previous chord dying away, or a change with no clean attack, arms the next one too
          if (++this.offFrames >= ARM_FRAMES) this.armed = true;
          if (f.chord) { this.lastHeard = f.chord.name; this.heardAt = now; }
        }

        if (this.armed && this.matchFrames >= HIT_FRAMES) {
          const results = this.results.slice();
          results[this.index] = this.misses > 0 ? "retry" : "clean";
          this.results = results;
          this.goTo(this.index + 1, false, f.onsetTime + REARM_MS);
        } else if (!m.match && f.chord && !this.judged) {
          // Only a strum made for this chord can be wrong, not the last chord still ringing
          const ownStrum = f.onsetTime > this.strumGuard;
          const sinceStrum = f.time - f.onsetTime;
          if (ownStrum && sinceStrum >= MISS_FROM_MS && sinceStrum <= MISS_TO_MS && ++this.missFrames >= MISS_FRAMES) {
            this.judged = true;
            this.misses++;
            this.wrong = true;
          }
        }
      }
    }

    this.heard = this.signal && now - this.heardAt < HEARD_HOLD_MS ? this.lastHeard : "";
  }
}

// ── React binding ─────────────────────────────────────────────────────────────

export interface PracticeTone {
  name: string;
  heard: boolean;
  required: boolean;
}

export interface ChordPractice {
  /** Position in the chord list of the chord to play now; equals the list length once finished. */
  index: number;
  /** Outcome per position in the chord list; undefined while unplayed. */
  results: readonly (StepResult | undefined)[];
  /** Whether each position holds a chord that can be checked (false for bar lines, `x2`, …). */
  playable: readonly boolean[];
  /** Notes of the chord to play, lit as they are heard. */
  tones: PracticeTone[];
  heard: string;
  wrong: boolean;
  signal: boolean;
  done: boolean;
  total: number;    // playable chords
  played: number;
  clean: number;
  jump: (index: number) => void;
  restart: () => void;
}

interface Snapshot {
  index: number;
  results: readonly (StepResult | undefined)[];
  toneBits: number;
  heard: string;
  wrong: boolean;
  signal: boolean;
}

const snapshot = (run: PracticeRun): Snapshot => ({
  index: run.index, results: run.results, toneBits: run.toneBits,
  heard: run.heard, wrong: run.wrong, signal: run.signal,
});

/** Walk `chords` (symbols as written in the song) while `enabled`. Starts over when either changes. */
export function useChordPractice(chords: readonly string[], enabled: boolean): ChordPractice {
  const parsed = useMemo(() => chords.map(parseChord), [chords]);
  const playable = useMemo(() => parsed.map(p => p !== null), [parsed]);
  const total = useMemo(() => playable.filter(Boolean).length, [playable]);

  const run = useMemo(() => new PracticeRun(parsed), [parsed]);
  const [snap, setSnap] = useState<Snapshot>(() => snapshot(run));

  useEffect(() => {
    if (!enabled) return;
    const stop = startChordTracker();
    run.restart();

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      run.step(performance.now());
      setSnap(prev => (
        prev.index === run.index && prev.results === run.results && prev.toneBits === run.toneBits
        && prev.heard === run.heard && prev.wrong === run.wrong && prev.signal === run.signal
          ? prev
          : snapshot(run)
      ));
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      stop();
    };
  }, [enabled, run]);

  const target = parsed[snap.index] ?? null;
  const tones: PracticeTone[] = target
    ? target.tones.map((t, i) => ({
        name: pitchClassName(t.pc),
        heard: (snap.toneBits & (1 << i)) !== 0,
        required: t.required,
      }))
    : [];

  let played = 0, clean = 0;
  for (let i = 0; i < parsed.length; i++) {
    const r = snap.results[i];
    if (!parsed[i] || !r) continue;
    played++;
    if (r === "clean") clean++;
  }

  return {
    index: snap.index,
    results: snap.results,
    playable,
    tones,
    heard: snap.heard,
    wrong: snap.wrong,
    signal: snap.signal,
    done: total > 0 && snap.index >= parsed.length,
    total,
    played,
    clean,
    jump: index => run.jump(index),
    restart: () => run.restart(),
  };
}
