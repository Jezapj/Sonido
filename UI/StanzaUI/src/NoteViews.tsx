import { useEffect, useRef, useState } from "react";
import { useIsLightMode } from "./UseTheme";
import { markClickHandled } from "./focusGuard";
import { midiToName, NOTE_NAMES, STRING_LABELS } from "./music";
import {
  getActiveNote, getNotes, getPitchFrame, getTrackerEpoch, type NoteEvent,
} from "./pitchTracker";
import { getGuide, guideJudgement, guideTime, judgeGuide, type Take, type TakeNote } from "./takes";

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
const GUIDE_LINE_FRAC = 0.6;

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
    const gt = guide ? guideTime(now) : 0;
    if (guide) judgeGuide(notes, now);

    const nowX = guide ? Math.round(w * GUIDE_LINE_FRAC) : w - 10;
    const pps = nowX / BAR_VISIBLE_SECS;
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

    const padTop = 16, padBot = 8;
    const rowH = (h - padTop - padBot) / (r.hi - r.lo);
    const yOf = (m: number) => padTop + (r.hi - m) * rowH;

    // Semitone grid
    const labelAll = rowH >= 10;
    ctx.lineWidth = 0.5;
    ctx.font = "9px monospace";
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

    const barH = clamp(rowH * 0.72, 4, 18);
    const fs = clamp(barH * 0.75, 8, 11);

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
      const label = n.fret !== null && n.string !== null
        ? `${midiToName(n.midi)} ${STRING_LABELS[n.string]}${n.fret}`
        : midiToName(n.midi);
      ctx.fillText(label, Math.max(2, x0), y + barH / 2 + 1);
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

    ctx.font = "9px monospace";
    ctx.textBaseline = "middle";
    ctx.fillStyle = p.dim;
    for (const [t, y] of labels) ctx.fillText(t, 4, y);

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

function staffPos(writtenMidi: number, clef: ClefKind) {
  const pc = ((writtenMidi % 12) + 12) % 12;
  const step = (Math.floor(writtenMidi / 12) - 1) * 7 + LETTER_OF_PC[pc];
  return { p: step - (clef === "bass" ? G2_STEP : E4_STEP), sharp: SHARP_PC.has(pc) };
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
    if (guide) judgeGuide(notes, now);

    const spawnX = guide ? Math.round(w * GUIDE_LINE_FRAC) : w - 18;
    const headerW = isTab ? Math.max(22, Math.round(h / 9)) : g * 3.4 + 6;
    const xOf = (n: NoteEvent) => spawnX - (L.scroll - (L.pos.get(n.id) ?? L.scroll));
    const alphaAt = (x: number) => clamp((x - headerW - 4) / 30, 0, 1);
    const liveStyle: NoteStyle<NoteEvent> = { xOf, alphaAt, color: n => n === cur ? p.accent : p.ink, glow: n => n === cur };

    // Guide notes cross the play line exactly at their recorded time; dense runs are spread out
    let guideStyle: NoteStyle<TakeNote> | null = null;
    if (guide) {
      const G = guideLayout(guideLayoutRef, guide, minGap);
      const head = G.headAt(guideTime(now));
      const gx = (n: TakeNote) => spawnX + (G.pos[G.index.get(n) ?? 0] - head);
      guideStyle = {
        xOf: gx,
        alphaAt: x => alphaAt(x) * clamp((w - 6 - x) / 30, 0, 1),
        color: n => guideColor(p, G.index.get(n) ?? 0),
        glow: n => Math.abs(gx(n) - spawnX) < minGap / 2,
      };
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
      if (guide && guideStyle) drawTabNotes(ctx, w, h, guide.notes, guideStyle);
      drawTabNotes(ctx, w, h, notes, liveStyle);
    } else {
      const frame = drawStaffFrame(ctx, w, h, g, p, clefRef.current, clefHitRef.current);
      if (guide && guideStyle) drawStaffNotes(ctx, w, g, frame, guide.notes, guideStyle, clefRef.current);
      drawStaffNotes(ctx, w, g, frame, notes, liveStyle, clefRef.current);
    }

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
  clef: ClefKind, hit: { x: number; y: number; w: number; h: number },
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

  return { bottom, yOfPos };
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
