import { useEffect, useRef, useState } from "react";
import { useIsLightMode } from "./UseTheme";
import { markClickHandled } from "./focusGuard";
import { midiToName, NOTE_NAMES, STRING_LABELS } from "./music";
import {
  getActiveNote, getNotes, getPitchFrame, getTrackerEpoch, type NoteEvent,
} from "./pitchTracker";
import { getGuide, guideJudgement, guideTime, judgeGuide, meterOf, type Take, type TakeNote } from "./takes";
import { barMs, buildScore, tickMs, TPQ, type Glyph, type Meter, type NoteValue, type Score } from "./rhythm";

// ── Shared helpers ────────────────────────────────────────────────────────────

interface Palette {
  accent: string;
  bar: string;
  barActive: string;
  grid: string;
  gridStrong: string;
  ink: string;
  dim: string;
  border: string;
  guide: string;
  guideFill: string;
  hit: string;
  miss: string;
}

const DARK: Palette = {
  accent:     "#AFA9EC",
  bar:        "rgba(175,169,236,0.42)",
  barActive:  "rgba(196,191,255,0.95)",
  grid:       "rgba(255,255,255,0.05)",
  gridStrong: "rgba(255,255,255,0.14)",
  ink:        "rgba(255,255,255,0.85)",
  dim:        "rgba(255,255,255,0.35)",
  border:     "rgba(255,255,255,0.12)",
  guide:      "#F5B971",
  guideFill:  "rgba(245,185,113,0.05)",
  hit:        "#5EE6A8",
  miss:       "rgba(239,68,68,0.6)",
};

const LIGHT: Palette = {
  accent:     "#6d28d9",
  bar:        "rgba(109,40,217,0.32)",
  barActive:  "rgba(109,40,217,0.9)",
  grid:       "rgba(0,0,0,0.06)",
  gridStrong: "rgba(0,0,0,0.16)",
  ink:        "rgba(26,15,46,0.88)",
  dim:        "rgba(26,15,46,0.45)",
  border:     "rgba(0,0,0,0.1)",
  guide:      "#c2410c",
  guideFill:  "rgba(194,65,12,0.05)",
  hit:        "#059669",
  miss:       "rgba(220,38,38,0.6)",
};

/** Where the play line sits when a guide take is loaded (fraction of width). */
const GUIDE_LINE_FRAC = 0.25;

const guideColor = (p: Palette, i: number) => {
  const j = guideJudgement(i);
  return j === 1 ? p.hit : j === 0 ? p.miss : p.guide;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Match the backing store to the element's CSS size × DPR and return a CSS-pixel context. */
function fitCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) return null;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return null;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function useRaf(active: boolean, draw: () => void) {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const loop = () => { drawRef.current(); id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [active]);
}

function usePalette() {
  const light = useIsLightMode();
  const ref = useRef<Palette>(light ? LIGHT : DARK);
  ref.current = light ? LIGHT : DARK;
  return ref;
}

function hint(ctx: CanvasRenderingContext2D, w: number, h: number, pal: Palette, text: string) {
  ctx.font = "11px monospace";
  ctx.fillStyle = pal.dim;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2);
}

const frameStyle = (pal: Palette): React.CSSProperties => ({
  position: "relative", flex: 1, minHeight: 0,
  border: `0.5px solid ${pal.border}`, borderRadius: 10, overflow: "hidden",
  marginBottom: 8,
});

const canvasStyle: React.CSSProperties = {
  position: "absolute", inset: 0, width: "100%", height: "100%", display: "block",
};

// ── Synced guides (tempo label, bar lines) ────────────────────────────────────

const TEMPO_LABEL_W = 110;

function drawTempo(ctx: CanvasRenderingContext2D, w: number, p: Palette, m: Meter) {
  ctx.font = "600 11px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = p.guide;
  ctx.fillText(`${m.den === 8 ? "♪" : "♩"} = ${Math.round(m.bpm)}   ${m.num}/${m.den}`, w - 6, 5);
}

interface BarLineStyle {
  y0: number;
  y1: number;
  numY: number;
  fontPx: number;
  alphaAt: (x: number) => number;
}

/** Bar lines with bar numbers; `xOfBar(k)` is where bar k + 1 starts, bar `bars` ends with a final double bar. */
function drawBarLines(
  ctx: CanvasRenderingContext2D, w: number, p: Palette, bars: number,
  xOfBar: (k: number) => number, s: BarLineStyle,
) {
  ctx.strokeStyle = p.dim;
  ctx.fillStyle = p.dim;
  ctx.font = `${s.fontPx}px monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (let k = 0; k <= bars; k++) {
    const x = Math.round(xOfBar(k)) + 0.5;
    if (x < -6 || x > w + 6) continue;
    const a = s.alphaAt(x);
    if (a <= 0) continue;
    ctx.globalAlpha = a;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, s.y0); ctx.lineTo(x, s.y1); ctx.stroke();
    if (k === bars) {
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x + 4, s.y0); ctx.lineTo(x + 4, s.y1); ctx.stroke();
    } else if (x < w - TEMPO_LABEL_W) {
      ctx.fillText(String(k + 1), x + 3, s.numY);
    }
  }
  ctx.globalAlpha = 1;
}

type Accidental = "sharp" | "natural" | null;

interface ClefLayout { pos: number[]; ottava: boolean[]; up: boolean[]; }

/** A synced take spelled as notation, cached per take object (edits make a new one). */
interface ScoreView {
  take: Take;
  meter: Meter;
  score: Score;
  tMs: number;
  acc: Accidental[];          // per glyph
  start: number[];            // per take note: quantised start tick, NaN when merged away
  end: number[];
  kept: TakeNote[];           // notes that survived quantising
  minSpacing: number;         // closest onsets (ticks), sets the scroll speed
  index: Map<TakeNote, number>;
  barFirst: (number | undefined)[];  // first glyph of each bar
  tupletGlyphs: number[][];
  clefs: Partial<Record<ClefKind, ClefLayout>>;
}

const scoreViews = new WeakMap<Take, ScoreView>();

function scoreView(take: Take, meter: Meter): ScoreView {
  const cached = scoreViews.get(take);
  if (cached) return cached;
  const score = buildScore(take.notes, meter);
  const { glyphs, barTicks: T } = score;
  const start = take.notes.map(() => NaN), end = take.notes.map(() => NaN);
  for (const q of score.notes) { start[q.note] = q.start; end[q.note] = q.end; }

  // Accidentals hold to the end of the bar; a note tied over keeps its own
  const acc: Accidental[] = [];
  const held = new Map<number, boolean>();
  let bar = -1;
  for (const gl of glyphs) {
    const b = Math.floor(gl.tick / T);
    if (b !== bar) { bar = b; held.clear(); }
    if (gl.note < 0 || gl.tieFromPrev) { acc.push(null); continue; }
    const { step, sharp } = diatonic(take.notes[gl.note].midi + 12);
    const was = held.get(step) ?? false;
    held.set(step, sharp);
    acc.push(sharp && !was ? "sharp" : !sharp && was ? "natural" : null);
  }

  const barFirst: (number | undefined)[] = [];
  glyphs.forEach((gl, i) => { if (gl.tick % T === 0) barFirst[gl.tick / T] ??= i; });
  const tupletGlyphs = score.tuplets.map(t =>
    glyphs.flatMap((gl, i) => (gl.tick >= t.start && gl.tick < t.end ? [i] : [])));
  let minSpacing = TPQ;
  for (let i = 1; i < score.notes.length; i++) {
    minSpacing = Math.min(minSpacing, score.notes[i].start - score.notes[i - 1].start);
  }

  const view: ScoreView = {
    take, meter, score, tMs: tickMs(meter), acc, start, end,
    kept: take.notes.filter((_, i) => !Number.isNaN(start[i])),
    minSpacing: Math.max(3, minSpacing),
    index: new Map(take.notes.map((n, i) => [n, i] as const)),
    barFirst, tupletGlyphs, clefs: {},
  };
  scoreViews.set(take, view);
  return view;
}

function clefLayout(sv: ScoreView, clef: ClefKind): ClefLayout {
  const cached = sv.clefs[clef];
  if (cached) return cached;
  const pos: number[] = [], ottava: boolean[] = [];
  for (const gl of sv.score.glyphs) {
    if (gl.note < 0) { pos.push(4); ottava.push(false); continue; }
    let { p } = staffPos(sv.take.notes[gl.note].midi + 12, clef);
    const o = p > 15;
    if (o) p -= 7;
    pos.push(p); ottava.push(o);
  }
  // Stems go up below the middle line; a beamed group follows its average
  const up = pos.map(p => p < 4);
  for (const grp of sv.score.beams) {
    const groupUp = grp.reduce((s, i) => s + pos[i], 0) / grp.length < 4;
    for (const i of grp) up[i] = groupUp;
  }
  return (sv.clefs[clef] = { pos, ottava, up });
}

interface SyncedGuide {
  sv: ScoreView;
  xOfTick: (tick: number) => number;
  alphaAt: (x: number) => number;
  color: (note: number) => string;    // note -1 = rest
  active: (note: number) => boolean;  // sounding at the play line
}

// ── Bars (horizontal rhythm-game / piano-roll) ────────────────────────────────

const BAR_VISIBLE_SECS = 6;
const BAR_MIN_SPAN = 14;

export function NoteBarsView({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pal = usePalette();
  const rangeRef = useRef({ lo: 47, hi: 61 });

  useRaf(active, () => {
    const fit = fitCanvas(canvasRef.current);
    if (!fit) return;
    const { ctx, w, h } = fit;
    const p = pal.current;
    const now = performance.now();
    const notes = getNotes();
    const fr = getPitchFrame();
    const cur = getActiveNote();
    const guide = getGuide();
    const meter = guide ? meterOf(guide) : null;
    const gt = guide ? guideTime(now) : 0;
    if (guide) judgeGuide(notes, now);

    const nowX = guide ? Math.round(w * GUIDE_LINE_FRAC) : w - 10;
    const pps = (guide ? w : nowX) / BAR_VISIBLE_SECS;
    const horizon = now - BAR_VISIBLE_SECS * 1000;

    const visible: NoteEvent[] = [];
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.end !== null && n.end < horizon) break;
      visible.push(n);
    }

    // Guide notes: x is relative to the play line, upcoming ones sit to its right
    const guideVis: { n: TakeNote; i: number; x0: number; x1: number }[] = [];
    if (guide) {
      for (let i = 0; i < guide.notes.length; i++) {
        const n = guide.notes[i];
        const x0 = nowX + ((n.startMs - gt) / 1000) * pps;
        if (x0 > w) break;
        const x1 = x0 + (n.durMs / 1000) * pps;
        if (x1 >= 0) guideVis.push({ n, i, x0, x1 });
      }
    }

    // Auto-fit the pitch range to what's on screen
    let lo = Infinity, hi = -Infinity;
    for (const n of visible) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
    for (const { n } of guideVis) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
    if (fr.voiced) { lo = Math.min(lo, fr.midi); hi = Math.max(hi, fr.midi); }
    const r = rangeRef.current;
    if (lo <= hi) {
      lo -= 2; hi += 2;
      if (hi - lo < BAR_MIN_SPAN) { const c = (lo + hi) / 2; lo = c - BAR_MIN_SPAN / 2; hi = c + BAR_MIN_SPAN / 2; }
      r.lo += (lo - r.lo) * 0.08;
      r.hi += (hi - r.hi) * 0.08;
    }

    const padTop = 20, padBot = 12;
    const rowH = (h - padTop - padBot) / (r.hi - r.lo);
    const yOf = (m: number) => padTop + (r.hi - m) * rowH;

    // Semitone grid
    const labelAll = rowH >= 10;
    ctx.lineWidth = 0.5;
    ctx.font = "11px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const labels: [string, number][] = [];
    for (let m = Math.ceil(r.lo); m <= Math.floor(r.hi); m++) {
      const y = yOf(m);
      const pc = ((m % 12) + 12) % 12;
      ctx.strokeStyle = pc === 0 ? p.gridStrong : p.grid;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      if (pc === 0 || (labelAll && !NOTE_NAMES[pc].includes("#"))) labels.push([midiToName(m), y]);
    }

    // Spawn line (and the upcoming-guide region to its right)
    if (guide) {
      ctx.fillStyle = p.guideFill;
      ctx.fillRect(nowX, 0, w - nowX, h);
    }
    ctx.strokeStyle = guide ? p.guide : p.gridStrong;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(nowX, 0); ctx.lineTo(nowX, h); ctx.stroke();

    if (guide && meter) {
      const bMs = barMs(meter);
      drawBarLines(ctx, w, p, scoreView(guide, meter).score.bars,
        k => nowX + ((meter.downbeatMs + k * bMs - gt) / 1000) * pps,
        { y0: 0, y1: h, numY: 10, fontPx: 10, alphaAt: () => 1 });
    }

    const barH = clamp(rowH * 0.72, 4, 18);
    const fs = clamp(barH * 0.95, 11, 15);

    // Guide bars (outlined, label underneath so it doesn't collide with live labels)
    ctx.font = `600 ${fs}px monospace`;
    ctx.textBaseline = "top";
    for (const { n, i, x0, x1 } of guideVis) {
      const y = yOf(n.midi);
      const col = guideColor(p, i);
      const crossing = x0 <= nowX && x1 >= nowX;
      const a = clamp(x1 / 40, 0, 1) * clamp((w - x0) / 40, 0, 1);
      const r = Math.min(4, barH / 2);
      ctx.beginPath();
      ctx.roundRect(x0, y - barH / 2, Math.max(3, x1 - x0), barH, r);
      ctx.globalAlpha = a * (crossing ? 0.45 : 0.22);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.globalAlpha = a;
      ctx.strokeStyle = col;
      ctx.lineWidth = crossing ? 1.5 : 1;
      if (crossing) { ctx.shadowColor = col; ctx.shadowBlur = 10; }
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = col;
      ctx.fillText(midiToName(n.midi), Math.max(2, x0), y + barH / 2 + 1);
    }
    ctx.globalAlpha = 1;

    // Live bars
    ctx.font = `600 ${fs}px monospace`;
    ctx.textBaseline = "bottom";
    for (const n of visible) {
      const x0 = nowX - ((now - n.start) / 1000) * pps;
      const x1 = nowX - ((now - (n.end ?? now)) / 1000) * pps;
      if (x1 < 0) continue;
      const y = yOf(n.midi);
      const isCur = n === cur;
      ctx.globalAlpha = clamp(x1 / 40, 0, 1);
      ctx.fillStyle = isCur ? p.barActive : p.bar;
      ctx.shadowColor = p.accent;
      ctx.shadowBlur = isCur ? 10 : 0;
      ctx.beginPath();
      ctx.roundRect(x0, y - barH / 2, Math.max(3, x1 - x0), barH, Math.min(4, barH / 2));
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = isCur ? p.accent : p.ink;
      ctx.fillText(midiToName(n.midi), Math.max(2, x0), y - barH / 2 - 1);
    }
    ctx.globalAlpha = 1;

    // Live pitch marker (shows bends / vibrato on the spawn line)
    if (fr.voiced) {
      ctx.fillStyle = p.accent;
      ctx.shadowColor = p.accent;
      ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(nowX, yOf(fr.midi), 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }

    ctx.font = "11px monospace";
    ctx.textBaseline = "middle";
    ctx.fillStyle = p.dim;
    for (const [t, y] of labels) ctx.fillText(t, 4, y);

    if (meter) drawTempo(ctx, w, p, meter);
    if (visible.length === 0 && !fr.voiced && !guide) hint(ctx, w, h, p, "play a note…");
  });

  return (
    <div style={frameStyle(pal.current)}>
      <canvas ref={canvasRef} style={canvasStyle} />
    </div>
  );
}

// ── Notation (staff / tab) ────────────────────────────────────────────────────

const SCORE_PPS = 70;
const MAX_LAYOUT = 600;
const LETTER_OF_PC = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const SHARP_PC = new Set([1, 3, 6, 8, 10]);
const E4_STEP = 4 * 7 + 2;   // diatonic step of the bottom treble line
const G2_STEP = 2 * 7 + 4;   // diatonic step of the bottom bass line

export type NotationMode = "staff" | "tab";
type ClefKind = "treble" | "bass";

interface ScoreLayout {
  epoch: number;
  pos: Map<number, number>;
  lastPos: number;
  scroll: number;
  lastTime: number;
}

function diatonic(writtenMidi: number) {
  const pc = ((writtenMidi % 12) + 12) % 12;
  return { step: (Math.floor(writtenMidi / 12) - 1) * 7 + LETTER_OF_PC[pc], sharp: SHARP_PC.has(pc) };
}

function staffPos(writtenMidi: number, clef: ClefKind) {
  const { step, sharp } = diatonic(writtenMidi);
  return { p: step - (clef === "bass" ? G2_STEP : E4_STEP), sharp };
}

type DrawNote = Pick<NoteEvent, "midi" | "string" | "fret">;

interface NoteStyle<T extends DrawNote> {
  xOf: (n: T) => number;
  alphaAt: (x: number) => number;
  color: (n: T) => string;
  glow: (n: T) => boolean;
}

interface GuideLayout {
  take: Take;
  minGap: number;
  pos: number[];
  index: Map<TakeNote, number>;
  headAt: (t: number) => number;
}

/** Spread guide notes like live ones (≥ minGap apart) and map take time → scroll position. */
function guideLayout(ref: { current: GuideLayout | null }, take: Take, minGap: number): GuideLayout {
  const cached = ref.current;
  if (cached && cached.take === take && cached.minGap === minGap) return cached;

  const pxPerMs = SCORE_PPS / 1000;
  const times = take.notes.map(n => n.startMs);
  const pos: number[] = [];
  for (let i = 0; i < times.length; i++) {
    pos.push(i === 0 ? times[0] * pxPerMs : Math.max(times[i] * pxPerMs, pos[i - 1] + minGap));
  }
  const headAt = (t: number) => {
    const n = times.length;
    if (n === 0) return t * pxPerMs;
    if (t <= times[0]) return pos[0] + (t - times[0]) * pxPerMs;
    if (t >= times[n - 1]) return pos[n - 1] + (t - times[n - 1]) * pxPerMs;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
    const span = times[hi] - times[lo];
    return span > 0 ? pos[lo] + ((pos[hi] - pos[lo]) * (t - times[lo])) / span : pos[hi];
  };
  const layout = { take, minGap, pos, index: new Map(take.notes.map((n, i) => [n, i] as const)), headAt };
  ref.current = layout;
  return layout;
}

export function NotationView({ active, mode }: { active: boolean; mode: NotationMode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pal = usePalette();
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [clef, setClef] = useState<ClefKind>("treble");
  const clefRef = useRef(clef);
  clefRef.current = clef;
  const clefHitRef = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const layoutRef = useRef<ScoreLayout>({ epoch: -1, pos: new Map(), lastPos: 0, scroll: 0, lastTime: 0 });
  const guideLayoutRef = useRef<GuideLayout | null>(null);

  useRaf(active, () => {
    const fit = fitCanvas(canvasRef.current);
    if (!fit) return;
    const { ctx, w, h } = fit;
    const p = pal.current;
    const now = performance.now();
    const notes = getNotes();
    const cur = getActiveNote();
    const isTab = modeRef.current === "tab";

    // Staff is zoomed out a bit more than tab (larger divisor → smaller notation).
    const g = clamp((h - 16) / 9.4, 5, 28);
    const minGap = Math.max(22, g * 3.2);

    // Lay notes out left→right: each new note spawns at the scroll head (or after the previous one)
    const L = layoutRef.current;
    if (L.epoch !== getTrackerEpoch()) {
      L.epoch = getTrackerEpoch(); L.pos.clear(); L.lastPos = 0; L.scroll = 0; L.lastTime = 0;
    }
    const dt = L.lastTime ? now - L.lastTime : 0;
    L.lastTime = now;
    L.scroll += (dt / 1000) * SCORE_PPS;
    let firstNew = notes.length;
    while (firstNew > 0 && !L.pos.has(notes[firstNew - 1].id)) firstNew--;
    for (let i = firstNew; i < notes.length; i++) {
      const pos = L.pos.size ? Math.max(L.scroll, L.lastPos + minGap) : L.scroll;
      L.pos.set(notes[i].id, pos);
      L.lastPos = pos;
    }
    if (L.pos.size > MAX_LAYOUT) {
      const keep = new Set(notes.map(n => n.id));
      for (const id of L.pos.keys()) if (!keep.has(id)) L.pos.delete(id);
    }
    if (L.lastPos > L.scroll) L.scroll += (L.lastPos - L.scroll) * 0.2;

    const guide = getGuide();
    const meter = guide ? meterOf(guide) : null;
    if (guide) judgeGuide(notes, now);

    const spawnX = guide ? Math.round(w * GUIDE_LINE_FRAC) : w - 18;
    const headerW = isTab ? Math.max(22, Math.round(h / 9)) : g * 3.4 + 6 + (meter ? g * 2.4 : 0);
    // A synced guide scrolls at a steady speed (its closest notes ≈ 2.2 staff spaces apart),
    // so live notes are placed by time too
    const sv = guide && meter ? scoreView(guide, meter) : null;
    const pxPerMs = sv ? Math.max((g * 2.2) / sv.minSpacing, g * 0.4) / sv.tMs : 0;
    const xOf = meter
      ? (n: NoteEvent) => spawnX - (now - n.start) * pxPerMs
      : (n: NoteEvent) => spawnX - (L.scroll - (L.pos.get(n.id) ?? L.scroll));
    const alphaAt = (x: number) => clamp((x - headerW - 4) / 30, 0, 1);
    const guideAlphaAt = (x: number) => alphaAt(x) * clamp((w - 6 - x) / 30, 0, 1);
    const liveStyle: NoteStyle<NoteEvent> = { xOf, alphaAt, color: n => n === cur ? p.accent : p.ink, glow: n => n === cur };

    let guideStyle: NoteStyle<TakeNote> | null = null;
    let synced: SyncedGuide | null = null;
    if (sv && meter) {
      const gt = guideTime(now);
      const msOf = (tick: number) => meter.downbeatMs + tick * sv.tMs;
      synced = {
        sv,
        xOfTick: t => spawnX + (msOf(t) - gt) * pxPerMs,
        alphaAt: guideAlphaAt,
        color: i => (i < 0 ? p.guide : guideColor(p, i)),
        active: i => gt >= msOf(sv.start[i]) && gt < msOf(sv.end[i]),
      };
    } else if (guide) {
      // Guide notes cross the play line exactly at their recorded time; dense runs are spread out
      const G = guideLayout(guideLayoutRef, guide, minGap);
      const head = G.headAt(guideTime(now));
      const gx = (n: TakeNote) => spawnX + (G.pos[G.index.get(n) ?? 0] - head);
      guideStyle = {
        xOf: gx,
        alphaAt: guideAlphaAt,
        color: n => guideColor(p, G.index.get(n) ?? 0),
        glow: n => Math.abs(gx(n) - spawnX) < minGap / 2,
      };
    }
    if (guide) {
      ctx.fillStyle = p.guideFill;
      ctx.fillRect(spawnX, 0, w - spawnX, h);
    }

    // Spawn cursor (the play line when a guide is loaded)
    const cursorX = guide ? spawnX : spawnX + minGap / 2;
    ctx.strokeStyle = guide ? p.guide : p.gridStrong;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cursorX, 4); ctx.lineTo(cursorX, h - 4); ctx.stroke();

    if (isTab) {
      drawTabFrame(ctx, w, h, p, headerW);
      if (synced) drawSyncedTab(ctx, w, h, p, synced);
      else if (guide && guideStyle) drawTabNotes(ctx, w, h, guide.notes, guideStyle);
      drawTabNotes(ctx, w, h, notes, liveStyle);
    } else {
      const frame = drawStaffFrame(ctx, w, h, g, p, clefRef.current, clefHitRef.current, meter);
      if (synced) drawScore(ctx, w, g, p, frame, synced, clefRef.current);
      else if (guide && guideStyle) drawStaffNotes(ctx, w, g, frame, guide.notes, guideStyle, clefRef.current);
      drawStaffNotes(ctx, w, g, frame, notes, liveStyle, clefRef.current);
    }

    if (meter) drawTempo(ctx, w, p, meter);
    if (notes.length === 0 && !guide) hint(ctx, w, h, p, "play a note…");
  });

  const overClef = (e: React.PointerEvent) => {
    if (modeRef.current !== "staff") return false;
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (canvas.clientWidth / r.width);
    const y = (e.clientY - r.top) * (canvas.clientHeight / r.height);
    const hit = clefHitRef.current;
    return x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h;
  };

  const onClefPointerDown = (e: React.PointerEvent) => {
    if (!overClef(e)) return;
    e.stopPropagation();
    e.preventDefault();
    markClickHandled();
    setClef(c => c === "treble" ? "bass" : "treble");
  };

  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.style.cursor = overClef(e) ? "pointer" : "";
  };

  return (
    <div style={frameStyle(pal.current)}>
      <canvas
        ref={canvasRef}
        style={canvasStyle}
        onPointerDown={onClefPointerDown}
        onPointerMove={onCanvasPointerMove}
        title={mode === "staff" ? "Tap the clef to switch treble / bass" : undefined}
      />
    </div>
  );
}

interface StaffFrame { bottom: number; yOfPos: (pos: number) => number; }

function drawStaffFrame(
  ctx: CanvasRenderingContext2D, w: number, h: number, g: number, p: Palette,
  clef: ClefKind, hit: { x: number; y: number; w: number; h: number }, meter: Meter | null,
): StaffFrame {
  const staffSpan = 4 * g;
  const above = g * 1.05;
  const below = g * 2.25;
  const block = staffSpan + above + below;
  const bottom = (h - block) / 2 + above + staffSpan;
  const yOfPos = (pos: number) => bottom - pos * (g / 2);

  ctx.strokeStyle = p.dim;
  ctx.lineWidth = Math.max(0.8, g / 14);
  for (let i = 0; i < 5; i++) {
    const y = bottom - i * g;
    ctx.beginPath(); ctx.moveTo(4, y); ctx.lineTo(w - 4, y); ctx.stroke();
  }

  // Clef + "8" below (guitar sounds an octave lower than written)
  ctx.fillStyle = p.ink;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const clefFont = `"Segoe UI Symbol", "Noto Music", "Apple Symbols", serif`;
  if (clef === "treble") {
    ctx.font = `${g * 5.58}px ${clefFont}`;
    ctx.fillText("\u{1D11E}", 4, bottom + g * 0.55);
  } else {
    ctx.font = `${g * 3.9}px ${clefFont}`;
    ctx.fillText("\u{1D122}", 5, bottom - g * 0.35);
  }
  ctx.font = `${Math.max(7, g)}px serif`;
  ctx.textAlign = "center";
  ctx.fillText("8", 6 + g * 1.15, bottom + g * 1.45);
  hit.x = 0; hit.y = bottom - 4.4 * g; hit.w = g * 3.4; hit.h = 6.2 * g;

  if (meter) {
    const tx = g * 3.4 + 6 + g * 1.1;
    ctx.font = `bold ${g * 2.2}px "Times New Roman", serif`;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(String(meter.num), tx, yOfPos(4) - g * 0.15);
    ctx.fillText(String(meter.den), tx, yOfPos(0) - g * 0.15);
  }

  return { bottom, yOfPos };
}

// ── Synced notation (real note values, rests, bar lines) ──────────────────────

const STEM = 3.3;   // stem length in staff spaces

const SHORT_VALUES = new Set<NoteValue>(["quarter", "eighth", "sixteenth"]);

function drawHead(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, g: number, value: NoteValue) {
  if (SHORT_VALUES.has(value)) {
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, -0.35, 0, Math.PI * 2); ctx.fill();
    return;
  }
  const half = value === "half";
  const lw = g * (half ? 0.16 : 0.22);
  const hrx = half ? rx : rx * 1.15;
  ctx.lineWidth = lw;
  ctx.beginPath(); ctx.ellipse(x, y, hrx - lw / 2, ry - lw / 2, half ? -0.35 : 0, 0, Math.PI * 2); ctx.stroke();
  if (value === "breve") {
    ctx.lineWidth = Math.max(1, g * 0.1);
    for (const side of [-1, 1]) for (const off of [0.2, 0.42]) {
      const bx = x + side * (hrx + g * off);
      ctx.beginPath(); ctx.moveTo(bx, y - ry * 1.4); ctx.lineTo(bx, y + ry * 1.4); ctx.stroke();
    }
  }
}

/** Flags hang from the stem tip back towards the head. */
function drawFlags(ctx: CanvasRenderingContext2D, sx: number, tip: number, up: boolean, count: number, g: number) {
  const d = up ? 1 : -1;
  ctx.lineWidth = Math.max(1.2, g * 0.2);
  for (let k = 0; k < count; k++) {
    const y0 = tip + d * k * g * 0.8;
    ctx.beginPath();
    ctx.moveTo(sx, y0);
    ctx.bezierCurveTo(sx + g * 0.1, y0 + d * g * 0.8, sx + g * 1.0, y0 + d * g * 1.0, sx + g * 0.7, y0 + d * g * 2.1);
    ctx.stroke();
  }
}

function drawRest(ctx: CanvasRenderingContext2D, x: number, g: number, yOfPos: (pos: number) => number, gl: Glyph) {
  const y4 = yOfPos(4);
  switch (gl.value) {
    case "breve": ctx.fillRect(x - g * 0.25, yOfPos(6), g * 0.5, g); break;
    case "whole": ctx.fillRect(x - g * 0.6, yOfPos(6), g * 1.2, g * 0.5); break;
    case "half":  ctx.fillRect(x - g * 0.6, y4 - g * 0.5, g * 1.2, g * 0.5); break;
    case "quarter": {
      ctx.lineWidth = g * 0.26;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(x - g * 0.15, y4 - g * 1.5);
      ctx.lineTo(x + g * 0.35, y4 - g * 0.85);
      ctx.lineTo(x - g * 0.2, y4 - g * 0.25);
      ctx.lineTo(x + g * 0.3, y4 + g * 0.45);
      ctx.quadraticCurveTo(x - g * 0.45, y4 + g * 0.25, x - g * 0.05, y4 + g * 1.25);
      ctx.stroke();
      ctx.lineJoin = "miter";
      break;
    }
    default: {
      // 8th / 16th: a slanted stem with one or two hooks
      const hooks = gl.value === "sixteenth" ? 2 : 1;
      const sx = x + g * 0.4, sy = y4 - g * 0.9;
      const len = g * (0.9 + hooks);
      ctx.lineWidth = Math.max(1, g * 0.13);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx - len * 0.3, sy + len); ctx.stroke();
      for (let k = 0; k < hooks; k++) {
        const ax = sx - k * g * 0.3, ay = sy + k * g;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(ax - g * 0.35, ay + g * 0.35, ax - g * 0.75, ay + g * 0.1); ctx.stroke();
        ctx.beginPath(); ctx.arc(ax - g * 0.72, ay + g * 0.02, g * 0.19, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  if (gl.dots) { ctx.beginPath(); ctx.arc(x + g * 0.85, yOfPos(5), g * 0.14, 0, Math.PI * 2); ctx.fill(); }
}

function drawScore(
  ctx: CanvasRenderingContext2D, w: number, g: number, p: Palette, frame: StaffFrame,
  sg: SyncedGuide, clef: ClefKind,
) {
  const { sv } = sg;
  const { glyphs, beams, barTicks: T, bars } = sv.score;
  const C = clefLayout(sv, clef);
  const { bottom, yOfPos } = frame;
  const rx = g * 0.66, ry = g * 0.47;
  const xs = glyphs.map(gl => gl.barRest
    ? (sg.xOfTick(gl.tick) + sg.xOfTick(gl.tick + gl.dur)) / 2
    : sg.xOfTick(gl.tick));
  const stemX = (i: number) => xs[i] + (C.up[i] ? rx - 0.5 : -rx + 0.5);

  // Bar lines sit just ahead of the downbeat (further when its note has an accidental)
  drawBarLines(ctx, w, p, bars, k => {
    const first = sv.barFirst[k];
    return sg.xOfTick(k * T) - g * (first !== undefined && sv.acc[first] ? 2.1 : 1.1);
  }, { y0: yOfPos(8), y1: yOfPos(0), numY: yOfPos(8) - g * 0.8, fontPx: clamp(g * 0.8, 8, 12), alphaAt: sg.alphaAt });

  for (let i = 0; i < glyphs.length; i++) {
    const gl = glyphs[i];
    const x = xs[i];
    if (x > w + 40) break;
    if (x < -40) continue;
    const a = sg.alphaAt(x);
    if (a <= 0) continue;
    const color = sg.color(gl.note);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    if (gl.note < 0) {
      ctx.globalAlpha = a * 0.75;
      drawRest(ctx, x, g, yOfPos, gl);
      continue;
    }
    ctx.globalAlpha = a;
    const pos = C.pos[i], up = C.up[i];
    const y = yOfPos(pos);

    ctx.lineWidth = 0.8;
    for (let k = -2; k >= pos; k -= 2) {
      const ly = yOfPos(k);
      ctx.beginPath(); ctx.moveTo(x - rx * 1.7, ly); ctx.lineTo(x + rx * 1.7, ly); ctx.stroke();
    }
    for (let k = 10; k <= pos; k += 2) {
      const ly = yOfPos(k);
      ctx.beginPath(); ctx.moveTo(x - rx * 1.7, ly); ctx.lineTo(x + rx * 1.7, ly); ctx.stroke();
    }

    const acc = sv.acc[i];
    if (acc) {
      ctx.font = `${g * 1.7}px "Segoe UI Symbol", serif`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(acc === "sharp" ? "♯" : "♮", x - rx - 1, y);
    }

    if (sg.active(gl.note)) { ctx.shadowColor = color; ctx.shadowBlur = 8; }
    drawHead(ctx, x, y, rx, ry, g, gl.value);
    ctx.shadowBlur = 0;

    if (gl.dots) {
      const dy = ((pos % 2) + 2) % 2 === 0 ? -g / 2 : 0;   // a head on a line puts its dot in the space above
      const hrx = SHORT_VALUES.has(gl.value) || gl.value === "half" ? rx : rx * 1.15;
      ctx.beginPath(); ctx.arc(x + hrx + g * 0.4, y + dy, g * 0.14, 0, Math.PI * 2); ctx.fill();
    }

    // Stem + flags (beamed stems are drawn with their beam)
    if (gl.beam < 0 && gl.value !== "whole" && gl.value !== "breve") {
      const sx = stemX(i);
      const len = g * (STEM + (gl.value === "sixteenth" ? 0.5 : 0));
      const tip = up ? Math.min(y - len, yOfPos(4)) : Math.max(y + len, yOfPos(4));
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx, y); ctx.lineTo(sx, tip); ctx.stroke();
      const flags = gl.value === "eighth" ? 1 : gl.value === "sixteenth" ? 2 : 0;
      if (flags) drawFlags(ctx, sx, tip, up, flags, g);
    }

    // Tie to the continuation, curving away from the stem
    if (gl.tieToNext && i + 1 < glyphs.length) {
      const x2 = xs[i + 1];
      const d = up ? 1 : -1;
      const ty = y + d * (ry + g * 0.25);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x + rx * 0.6, ty);
      ctx.quadraticCurveTo((x + x2) / 2, ty + d * g * 0.8, x2 - rx * 0.6, ty);
      ctx.stroke();
    }

    if (C.ottava[i]) {
      ctx.font = `italic ${Math.max(8, g)}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText("8va", x, Math.min(y - g * 3.6, bottom - g * 4.4));
    }
  }

  // Beams: a gently sloped line through the end stems, pushed clear of every head
  const bt = g * 0.42;
  for (const grp of beams) {
    const last = grp.length - 1;
    if (xs[grp[last]] < -40 || xs[grp[0]] > w + 40) continue;
    const up = C.up[grp[0]];
    const d = up ? -1 : 1;
    const sx = grp.map(stemX);
    const ys = grp.map(i => yOfPos(C.pos[i]));
    const tip0 = ys[0] + d * g * STEM;
    const span = sx[last] - sx[0];
    const slope = span > 0 ? clamp(ys[last] + d * g * STEM - tip0, -g, g) / span : 0;
    let shift = 0;
    for (let j = 0; j <= last; j++) {
      const base = tip0 + slope * (sx[j] - sx[0]);
      shift = up ? Math.min(shift, ys[j] - g * 2.5 - base) : Math.max(shift, ys[j] + g * 2.5 - base);
    }
    const lineY = (x: number) => tip0 + slope * (x - sx[0]) + shift;
    const seg = (xa: number, xb: number, level: number) => {
      const off = -d * level * g * 0.75;   // inner beams sit towards the heads
      const ya = lineY(xa) + off, yb = lineY(xb) + off;
      ctx.beginPath();
      ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.lineTo(xb, yb - d * bt); ctx.lineTo(xa, ya - d * bt);
      ctx.closePath(); ctx.fill();
    };
    for (let j = 0; j <= last; j++) {
      const gl = glyphs[grp[j]];
      const a = sg.alphaAt(xs[grp[j]]);
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      const col = sg.color(gl.note);
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx[j], ys[j]); ctx.lineTo(sx[j], lineY(sx[j])); ctx.stroke();
      if (j < last) seg(sx[j], sx[j + 1], 0);
      if (gl.value !== "sixteenth") continue;
      const prev16 = j > 0 && glyphs[grp[j - 1]].value === "sixteenth";
      const next16 = j < last && glyphs[grp[j + 1]].value === "sixteenth";
      if (next16) seg(sx[j], sx[j + 1], 1);
      else if (!prev16) {
        // Lone 16th: a stub pointing into the group
        const stub = Math.min(g * 1.1, (j === last ? sx[j] - sx[j - 1] : sx[j + 1] - sx[j]) * 0.5);
        if (j === last) seg(sx[j] - stub, sx[j], 1); else seg(sx[j], sx[j] + stub, 1);
      }
    }
  }

  // Triplet numbers above each triplet beat
  ctx.font = `italic ${Math.max(8, g * 1.05)}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (const ids of sv.tupletGlyphs) {
    const xa = xs[ids[0]], xb = xs[ids[ids.length - 1]];
    if (xb < -40 || xa > w + 40) continue;
    let top = yOfPos(8) - g * 0.6;
    for (const i of ids) {
      if (glyphs[i].note < 0) continue;
      top = Math.min(top, yOfPos(C.pos[i]) - (C.up[i] ? g * (STEM + 0.4) : g * 1.2));
    }
    const mid = (xa + xb) / 2;
    const a = sg.alphaAt(mid);
    if (a <= 0) continue;
    ctx.globalAlpha = a;
    ctx.fillStyle = p.guide;
    ctx.fillText("3", mid, top);
  }
  ctx.globalAlpha = 1;
}

function drawSyncedTab(ctx: CanvasRenderingContext2D, w: number, h: number, p: Palette, sg: SyncedGuide) {
  const { sv } = sg;
  const s = tabSpacing(h);
  const top = (h - 5 * s) / 2;
  const fs = clamp(s * 0.72, 9, 22);
  const T = sv.score.barTicks;
  drawBarLines(ctx, w, p, sv.score.bars, k => sg.xOfTick(k * T) - fs * 0.9,
    { y0: top, y1: top + 5 * s, numY: top - s * 0.7, fontPx: clamp(s * 0.5, 8, 11), alphaAt: sg.alphaAt });
  const at = (n: TakeNote) => sv.index.get(n) ?? 0;
  drawTabNotes(ctx, w, h, sv.kept, {
    xOf: n => sg.xOfTick(sv.start[at(n)]),
    alphaAt: sg.alphaAt,
    color: n => sg.color(at(n)),
    glow: n => sg.active(at(n)),
  });
}

function drawStaffNotes<T extends DrawNote>(
  ctx: CanvasRenderingContext2D, w: number, g: number, frame: StaffFrame,
  notes: readonly T[], style: NoteStyle<T>, clef: ClefKind,
) {
  const { bottom, yOfPos } = frame;
  const rx = g * 0.66, ry = g * 0.47;
  for (const n of notes) {
    const x = style.xOf(n);
    if (x > w + rx) continue;
    const a = style.alphaAt(x);
    if (a <= 0) continue;

    let { p: pos, sharp } = staffPos(n.midi + 12, clef);
    let ottava = false;
    if (pos > 15) { pos -= 7; ottava = true; }
    const y = yOfPos(pos);
    const color = style.color(n);
    ctx.globalAlpha = a;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    ctx.lineWidth = 0.8;
    for (let k = -2; k >= pos; k -= 2) {
      const ly = yOfPos(k);
      ctx.beginPath(); ctx.moveTo(x - rx * 1.7, ly); ctx.lineTo(x + rx * 1.7, ly); ctx.stroke();
    }
    for (let k = 10; k <= pos; k += 2) {
      const ly = yOfPos(k);
      ctx.beginPath(); ctx.moveTo(x - rx * 1.7, ly); ctx.lineTo(x + rx * 1.7, ly); ctx.stroke();
    }

    if (style.glow(n)) { ctx.shadowColor = color; ctx.shadowBlur = 8; }
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, -0.35, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    ctx.lineWidth = 1;
    ctx.beginPath();
    if (pos < 4) { ctx.moveTo(x + rx - 0.5, y); ctx.lineTo(x + rx - 0.5, y - g * 3.3); }
    else         { ctx.moveTo(x - rx + 0.5, y); ctx.lineTo(x - rx + 0.5, y + g * 3.3); }
    ctx.stroke();

    if (sharp) {
      ctx.font = `${g * 1.7}px "Segoe UI Symbol", serif`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText("\u266F", x - rx - 1, y);
    }
    if (ottava) {
      ctx.font = `italic ${Math.max(8, g)}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText("8va", x, Math.min(y - g * 3.6, bottom - g * 4.4));
    }
  }
  ctx.globalAlpha = 1;
}

const tabSpacing = (h: number) => clamp((h - 28) / 7.4, 7, 22);

function drawTabFrame(ctx: CanvasRenderingContext2D, w: number, h: number, p: Palette, headerW: number) {
  const s = tabSpacing(h);
  const top = (h - 5 * s) / 2;
  const labelFs = clamp(s * 0.55, 9, 16);

  ctx.strokeStyle = p.dim;
  ctx.lineWidth = Math.max(0.8, s / 18);
  ctx.font = `600 ${labelFs}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let str = 0; str < 6; str++) {
    const y = top + (5 - str) * s;   // high e on top
    ctx.beginPath(); ctx.moveTo(headerW, y); ctx.lineTo(w - 4, y); ctx.stroke();
    ctx.fillStyle = p.dim;
    ctx.fillText(STRING_LABELS[str], headerW / 2 + 1, y);
  }
}

function drawTabNotes<T extends DrawNote>(
  ctx: CanvasRenderingContext2D, w: number, h: number, notes: readonly T[], style: NoteStyle<T>,
) {
  const s = tabSpacing(h);
  const top = (h - 5 * s) / 2;
  const fs = clamp(s * 0.72, 9, 22);
  ctx.font = `700 ${fs}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const n of notes) {
    if (n.string === null || n.fret === null) continue;
    const x = style.xOf(n);
    if (x > w) continue;
    const a = style.alphaAt(x);
    if (a <= 0) continue;
    const y = top + (5 - n.string) * s;
    const label = String(n.fret);
    const tw = ctx.measureText(label).width;

    // Knock the string line out behind the number
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = a;
    ctx.fillRect(x - tw / 2 - 2, y - fs / 2, tw + 4, fs);
    ctx.globalCompositeOperation = "source-over";

    ctx.globalAlpha = a;
    const color = style.color(n);
    ctx.fillStyle = color;
    if (style.glow(n)) { ctx.shadowColor = color; ctx.shadowBlur = 8; }
    ctx.fillText(label, x, y + 0.5);
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
}
