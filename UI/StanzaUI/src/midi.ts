/**
 * Minimal Standard MIDI File (SMF) reader / writer.
 * Times are exchanged in milliseconds; the writer emits a fixed tempo,
 * the reader honours any tempo map in the file.
 */

export interface MidiNoteMs {
  midi: number;
  startMs: number;
  durMs: number;
  velocity: number;   // 1..127
  channel: number;    // 0..15
}

export interface MidiWriteInput {
  name: string;
  bpm: number;        // quarter notes per minute
  timeSig: [number, number];
  program: number;    // General MIDI program, 0-based
  channels: number[]; // channels that get the program change
  texts?: string[];
  notes: MidiNoteMs[];
}

export interface MidiReadResult {
  name: string;
  bpm: number;        // quarter notes per minute, from the first tempo event
  timeSig: [number, number];
  texts: string[];
  notes: MidiNoteMs[];
}

const PPQ = 480;

// ── Writing ───────────────────────────────────────────────────────────────────

function varLen(n: number): number[] {
  let v = Math.max(0, Math.round(n));
  const out = [v & 0x7f];
  while ((v >>= 7) > 0) out.unshift((v & 0x7f) | 0x80);
  return out;
}

const ascii = (s: string) => Array.from(new TextEncoder().encode(s));
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];

function meta(type: number, data: number[]): number[] {
  return [0xff, type, ...varLen(data.length), ...data];
}

interface AbsEvent { tick: number; order: number; bytes: number[]; }

function chunk(id: string, events: AbsEvent[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let last = 0;
  for (const e of events) {
    body.push(...varLen(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  body.push(0, ...meta(0x2f, []));
  return [...ascii(id), ...u32(body.length), ...body];
}

export function encodeMidi(input: MidiWriteInput): Uint8Array {
  const bpm = Math.min(300, Math.max(20, input.bpm || 120));
  const ticksPerMs = (bpm / 60000) * PPQ;
  const usPerBeat = Math.round(60_000_000 / bpm);
  const [num, den] = input.timeSig;

  const tempo: AbsEvent[] = [
    { tick: 0, order: 0, bytes: meta(0x03, ascii(input.name)) },
    { tick: 0, order: 1, bytes: meta(0x51, [(usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff]) },
    { tick: 0, order: 2, bytes: meta(0x58, [num, Math.round(Math.log2(den)), 24, 8]) },
  ];

  const track: AbsEvent[] = [{ tick: 0, order: 0, bytes: meta(0x03, ascii("Guitar")) }];
  for (const t of input.texts ?? []) track.push({ tick: 0, order: 1, bytes: meta(0x01, ascii(t)) });
  for (const ch of input.channels) {
    track.push({ tick: 0, order: 2, bytes: [0xc0 | (ch & 0x0f), input.program & 0x7f] });
  }
  for (const n of input.notes) {
    const on = Math.round(n.startMs * ticksPerMs);
    const off = Math.max(on + 1, Math.round((n.startMs + n.durMs) * ticksPerMs));
    const ch = n.channel & 0x0f;
    const key = Math.min(127, Math.max(0, n.midi));
    const vel = Math.min(127, Math.max(1, Math.round(n.velocity)));
    // note-offs sort before note-ons on the same tick
    track.push({ tick: on, order: 4, bytes: [0x90 | ch, key, vel] });
    track.push({ tick: off, order: 3, bytes: [0x80 | ch, key, 0] });
  }

  const header = [...ascii("MThd"), ...u32(6), ...u16(1), ...u16(2), ...u16(PPQ)];
  return new Uint8Array([...header, ...chunk("MTrk", tempo), ...chunk("MTrk", track)]);
}

// ── Reading ───────────────────────────────────────────────────────────────────

interface RawNote { tick: number; endTick: number; midi: number; velocity: number; channel: number; }

export function decodeMidi(bytes: Uint8Array): MidiReadResult {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o: number, n: number) => String.fromCharCode(...bytes.subarray(o, o + n));
  if (str(0, 4) !== "MThd") throw new Error("Not a MIDI file");

  const headerLen = dv.getUint32(4);
  const nTracks = dv.getUint16(10);
  const division = dv.getUint16(12);
  let pos = 8 + headerLen;

  const tempos: { tick: number; us: number }[] = [];
  let timeSig: [number, number] | null = null;
  let name = "";
  const texts: string[] = [];
  const raw: RawNote[] = [];
  const decoder = new TextDecoder();

  for (let t = 0; t < nTracks && pos + 8 <= bytes.length; t++) {
    const id = str(pos, 4);
    const len = dv.getUint32(pos + 4);
    const start = pos + 8;
    const end = Math.min(bytes.length, start + len);
    pos = end;
    if (id !== "MTrk") continue;

    let p = start;
    let tick = 0;
    let status = 0;
    const open = new Map<number, RawNote[]>();
    const readVar = () => {
      let v = 0, b = 0;
      do { b = bytes[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && p < end);
      return v;
    };

    while (p < end) {
      tick += readVar();
      let b = bytes[p];
      if (b & 0x80) { status = b; p++; } else if (status < 0x80) break;
      b = status;

      if (b === 0xff) {
        const type = bytes[p++];
        const l = readVar();
        const data = bytes.subarray(p, p + l);
        p += l;
        if (type === 0x51 && l === 3) tempos.push({ tick, us: (data[0] << 16) | (data[1] << 8) | data[2] });
        else if (type === 0x58 && l >= 2 && !timeSig) timeSig = [data[0], 2 ** data[1]];
        else if (type === 0x03 && !name) name = decoder.decode(data).trim();
        else if (type === 0x01) texts.push(decoder.decode(data));
        else if (type === 0x2f) break;
        status = 0;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) { p += readVar(); status = 0; continue; }

      const kind = b & 0xf0;
      const ch = b & 0x0f;
      const d1 = bytes[p++];
      const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[p++];
      const key = ch * 128 + d1;

      if (kind === 0x90 && d2 > 0) {
        const n: RawNote = { tick, endTick: -1, midi: d1, velocity: d2, channel: ch };
        const stack = open.get(key);
        if (stack) stack.push(n); else open.set(key, [n]);
        raw.push(n);
      } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
        const n = open.get(key)?.shift();
        if (n) n.endTick = tick;
      }
    }
    for (const stack of open.values()) for (const n of stack) if (n.endTick < 0) n.endTick = tick;
  }

  let tickToMs: (tick: number) => number;
  if (division & 0x8000) {
    const fps = 256 - (division >> 8);
    const perSec = fps * (division & 0xff);
    tickToMs = tick => (tick / perSec) * 1000;
  } else {
    const ppq = division || PPQ;
    tempos.sort((a, b) => a.tick - b.tick);
    if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, us: 500_000 });
    const msAt: number[] = [0];
    for (let i = 1; i < tempos.length; i++) {
      msAt.push(msAt[i - 1] + ((tempos[i].tick - tempos[i - 1].tick) * tempos[i - 1].us) / ppq / 1000);
    }
    tickToMs = tick => {
      let i = tempos.length - 1;
      while (i > 0 && tempos[i].tick > tick) i--;
      return msAt[i] + ((tick - tempos[i].tick) * tempos[i].us) / ppq / 1000;
    };
  }

  const notes = raw
    .filter(n => n.channel !== 9)
    .map(n => {
      const startMs = tickToMs(n.tick);
      return {
        midi: n.midi, startMs, durMs: Math.max(1, tickToMs(n.endTick) - startMs),
        velocity: n.velocity, channel: n.channel,
      };
    })
    .sort((a, b) => a.startMs - b.startMs);

  const bpm = tempos.length ? 60_000_000 / tempos[0].us : 120;
  return { name, bpm, timeSig: timeSig ?? [4, 4], texts, notes };
}
