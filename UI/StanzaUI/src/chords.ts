/**
 * chords
 *
 * Chord theory shared by the chord tracker and the Chord Bank's practice mode:
 * reading a written chord symbol into pitch classes, and the vocabulary of
 * chord types the tracker can name on its own.
 */

/** Root spellings as they usually appear on chord charts (flats for Eb / Ab / Bb). */
export const CHORD_ROOT_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

export const pitchClassName = (pc: number): string => CHORD_ROOT_NAMES[((pc % 12) + 12) % 12];

export interface ChordTone {
  pc: number;         // pitch class, 0 = C
  interval: number;   // semitones above the root, 0..11
  /** False for tones guitar voicings routinely leave out (the fifth of a 7th chord, the 9th of a 13th). */
  required: boolean;
}

export interface ParsedChord {
  symbol: string;        // as written
  root: number;          // pitch class
  bass: number | null;   // slash bass, when written
  tones: ChordTone[];    // root first, then by interval
}

// ── Vocabulary the tracker names without being told what to expect ────────────

export interface ChordQuality {
  suffix: string;
  intervals: number[];
  /** Subtracted from the match score, so richer chords need clearer evidence than a plain triad. */
  penalty: number;
}

export const CHORD_QUALITIES: ChordQuality[] = [
  { suffix: "",     intervals: [0, 4, 7],     penalty: 0 },
  { suffix: "m",    intervals: [0, 3, 7],     penalty: 0 },
  { suffix: "5",    intervals: [0, 7],        penalty: 0.05 },
  { suffix: "7",    intervals: [0, 4, 7, 10], penalty: 0.02 },
  { suffix: "maj7", intervals: [0, 4, 7, 11], penalty: 0.02 },
  { suffix: "m7",   intervals: [0, 3, 7, 10], penalty: 0.02 },
  { suffix: "sus4", intervals: [0, 5, 7],     penalty: 0.02 },
  { suffix: "sus2", intervals: [0, 2, 7],     penalty: 0.02 },
  { suffix: "add9", intervals: [0, 2, 4, 7],  penalty: 0.03 },
  { suffix: "dim",  intervals: [0, 3, 6],     penalty: 0.03 },
  { suffix: "aug",  intervals: [0, 4, 8],     penalty: 0.03 },
];

export const chordName = (root: number, suffix: string): string => pitchClassName(root) + suffix;

// ── Reading chord symbols ─────────────────────────────────────────────────────

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function readNote(s: string, at: number): { pc: number; next: number } | null {
  const base = LETTER_PC[s[at]];
  if (base === undefined) return null;
  let pc = base, next = at + 1;
  if (s[next] === "#") { pc++; next++; }
  else if (s[next] === "b") { pc--; next++; }
  return { pc: (pc + 12) % 12, next };
}

const ADD_INTERVAL: Record<string, number> = { "2": 2, "9": 2, "4": 5, "11": 5, "6": 9, "13": 9 };

const parseCache = new Map<string, ParsedChord | null>();

/**
 * Read a chord symbol such as `Am`, `F#m7b5`, `Cadd9`, `G7sus4` or `D/F#`.
 * Returns null for anything that is not a chord (bar lines, `x2`, `N.C.`, words).
 */
export function parseChord(symbol: string): ParsedChord | null {
  const cached = parseCache.get(symbol);
  if (cached !== undefined) return cached;
  const parsed = parseChordUncached(symbol);
  if (parseCache.size > 2000) parseCache.clear();
  parseCache.set(symbol, parsed);
  return parsed;
}

function parseChordUncached(symbol: string): ParsedChord | null {
  const s = symbol.trim()
    .replace(/♯/g, "#").replace(/♭/g, "b")
    .replace(/[Δ△]/g, "maj").replace(/ø/g, "m7b5").replace(/[°º]/g, "dim")
    .replace(/[()\s,]/g, "")
    .replace(/^[|:[\]]+/, "").replace(/[|:[\].*]+$/, "");

  const root = readNote(s, 0);
  if (!root) return null;
  let rest = s.slice(root.next);

  let bass: number | null = null;
  const slash = rest.lastIndexOf("/");
  if (slash >= 0) {
    const b = readNote(rest, slash + 1);
    if (b && b.next === rest.length) { bass = b.pc; rest = rest.slice(0, slash); }
  }

  const take = (re: RegExp): RegExpMatchArray | null => {
    const m = rest.match(re);
    if (m) rest = rest.slice(m[0].length);
    return m;
  };

  let third: number | null = 4;
  let fifth: number | null = 7;
  let seventh: number | null = null;
  const adds = new Set<number>();
  const optional = new Set<number>();
  let majSeven = false, dim = false, plain = false;

  if (take(/^(maj|Maj|MAJ|ma(?=\d|$)|M(?![a-z]))/)) majSeven = true;
  else if (take(/^(min|mi|m|-)/)) third = 3;
  else if (take(/^(dim|o(?=\d|$))/)) { third = 3; fifth = 6; dim = true; }
  else if (take(/^(aug|\+)/)) fifth = 8;
  else plain = true;
  if (third === 3 && !dim && take(/^(maj|Maj|M)(?=7|9|11|13)/)) majSeven = true;   // mMaj7

  const sev = () => (majSeven ? 11 : dim ? 9 : 10);
  const num = take(/^(13|11|9|7|69|6\/9|6|5|4|2)/);
  if (num) {
    switch (num[1]) {
      case "5":
        if (!plain) return null;
        third = null;
        break;
      case "6": adds.add(9); break;
      case "69":
      case "6/9": adds.add(9); adds.add(2); break;
      case "7": seventh = sev(); break;
      case "9": seventh = sev(); adds.add(2); break;
      case "11":
        seventh = sev(); adds.add(5); adds.add(2);
        optional.add(2); optional.add(3); optional.add(4);
        break;
      case "13":
        seventh = sev(); adds.add(9); adds.add(2);
        optional.add(2);
        break;
      case "2": adds.add(2); break;
      case "4": third = null; adds.add(5); break;
    }
  }

  while (rest) {
    let m: RegExpMatchArray | null;
    if (take(/^sus2/)) { third = null; adds.add(2); }
    else if (take(/^sus4?/)) { third = null; adds.add(5); }
    else if ((m = take(/^add(13|11|9|6|4|2)/))) adds.add(ADD_INTERVAL[m[1]]);
    else if (take(/^(b9|-9)/)) adds.add(1);
    else if (take(/^(#9|\+9)/)) adds.add(3);
    else if (take(/^(#11|\+11)/)) adds.add(6);
    else if (take(/^(b13|-13)/)) adds.add(8);
    else if (take(/^(b5|-5)/)) fifth = 6;
    else if (take(/^(#5|\+5|\+(?!\d))/)) fifth = 8;
    else if (take(/^(maj|Maj|M)7/)) seventh = 11;
    else if (take(/^7/)) seventh = 10;
    else if (take(/^no3/)) third = null;
    else if (take(/^no5/)) fifth = null;
    else return null;
  }

  const byInterval = new Map<number, boolean>();   // interval → required
  const put = (interval: number, required: boolean) => {
    byInterval.set(interval, (byInterval.get(interval) ?? false) || required);
  };
  put(0, true);
  if (third !== null) put(third, !optional.has(third));
  if (seventh !== null) put(seventh, true);
  adds.forEach(i => put(i, !optional.has(i)));
  if (bass !== null) put((bass - root.pc + 12) % 12, true);
  if (fifth !== null) {
    // A perfect fifth is dropped from most voicings of four-note-and-up chords, and the
    // root's own overtones fill it in anyway. An altered fifth is what names the chord.
    put(fifth, fifth !== 7 || byInterval.size < 3);
  }

  const tones: ChordTone[] = [...byInterval.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([interval, required]) => ({ pc: (root.pc + interval) % 12, interval, required }));

  return { symbol, root: root.pc, bass, tones };
}
