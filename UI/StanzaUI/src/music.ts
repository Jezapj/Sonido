// ── Note naming ───────────────────────────────────────────────────────────────

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function midiToName(midi: number, withOctave = true): string {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  return withOctave ? `${name}${Math.floor(midi / 12) - 1}` : name;
}

export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

// ── Guitar (standard tuning, low E → high e) ──────────────────────────────────

export const STANDARD_TUNING = [40, 45, 50, 55, 59, 64];
export const STRING_LABELS   = ["E", "A", "D", "G", "B", "e"];
export const FRET_COUNT      = 22;
export const HAND_SPAN       = 5;   // frets reachable without shifting position

export interface Fingering { string: number; fret: number; }

export interface FingeringState {
  started: boolean;
  hand: number;        // lowest fret of the current 5-fret hand window
  prevString: number;
  prevFret: number;    // last fretted (non-open) fret
}

export function newFingeringState(): FingeringState {
  return { started: false, hand: 1, prevString: 0, prevFret: 0 };
}

/**
 * Pick a string/fret for `midi`, favouring the least string movement while
 * staying inside a 5-fret hand window (open strings are always reachable).
 * The window only shifts when no in-window option exists. Mutates `st`.
 */
export function assignFingering(midi: number, st: FingeringState): Fingering | null {
  let best: Fingering | null = null;
  let bestCost = Infinity;

  for (let s = 0; s < STANDARD_TUNING.length; s++) {
    const fret = midi - STANDARD_TUNING[s];
    if (fret < 0 || fret > FRET_COUNT) continue;

    let cost: number;
    if (!st.started) {
      cost = fret;
    } else {
      const top = st.hand + HAND_SPAN - 1;
      const inWindow = fret === 0 || (fret >= st.hand && fret <= top);
      cost = Math.abs(s - st.prevString);
      if (fret > 0 && st.prevFret > 0) cost += Math.abs(fret - st.prevFret) * 0.25;
      if (!inWindow) {
        const shift = fret < st.hand ? st.hand - fret : fret - top;
        cost += 8 + shift * 1.5;
      }
    }
    if (cost < bestCost) { bestCost = cost; best = { string: s, fret }; }
  }

  if (!best) return null;

  if (best.fret > 0) {
    if (!st.started)                               st.hand = Math.max(1, best.fret - 1);
    else if (best.fret < st.hand)                  st.hand = best.fret;
    else if (best.fret > st.hand + HAND_SPAN - 1)  st.hand = best.fret - HAND_SPAN + 1;
    st.prevFret = best.fret;
  }
  st.prevString = best.string;
  st.started = true;
  return best;
}
