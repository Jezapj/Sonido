import { useEffect, useRef, useState } from "react";
import { useIsLightMode } from "./UseTheme";
import { midiToName, NOTE_NAMES, STRING_LABELS } from "./music";
import {
  getActiveNote, getNotes, getPitchFrame, getTrackerEpoch, type NoteEvent,
} from "./pitchTracker";

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

    const nowX = w - 10;
    const pps = w / BAR_VISIBLE_SECS;
    const horizon = now - BAR_VISIBLE_SECS * 1000;

    const visible: NoteEvent[] = [];
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.end !== null && n.end < horizon) break;
      visible.push(n);
    }

    // Auto-fit the pitch range to what's on screen
    let lo = Infinity, hi = -Infinity;
    for (const n of visible) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
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

    // Spawn line
    ctx.strokeStyle = p.gridStrong;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(nowX, 0); ctx.lineTo(nowX, h); ctx.stroke();

    // Bars
    const barH = clamp(rowH * 0.72, 4, 18);
    const fs = clamp(barH * 0.75, 8, 11);
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

    if (visible.length === 0 && !fr.voiced) hint(ctx, w, h, p, "play a note…");
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

    const spawnX = w - 18;
    const headerW = isTab ? Math.max(22, Math.round(h / 9)) : g * 3.4 + 6;
    const xOf = (n: NoteEvent) => spawnX - (L.scroll - (L.pos.get(n.id) ?? L.scroll));
    const alphaAt = (x: number) => clamp((x - headerW - 4) / 30, 0, 1);

    // Spawn cursor
    ctx.strokeStyle = p.gridStrong;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(spawnX + minGap / 2, 4); ctx.lineTo(spawnX + minGap / 2, h - 4); ctx.stroke();

    if (isTab) drawTab(ctx, w, h, p, notes, cur, xOf, alphaAt, headerW);
    else       drawStaff(ctx, w, h, g, p, notes, cur, xOf, alphaAt, clefRef.current, clefHitRef.current);

    if (notes.length === 0) hint(ctx, w, h, p, "play a note…");
  });

  const onClefPointerDown = (e: React.PointerEvent) => {
    if (modeRef.current !== "staff") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const scaleX = canvas.clientWidth / r.width;
    const x = (e.clientX - r.left) * scaleX;
    const y = (e.clientY - r.top) * (canvas.clientHeight / r.height);
    const hit = clefHitRef.current;
    if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
      e.stopPropagation();
      e.preventDefault();
      setClef(c => c === "treble" ? "bass" : "treble");
    }
  };

  return (
    <div style={frameStyle(pal.current)}>
      <canvas
        ref={canvasRef}
        style={{ ...canvasStyle, cursor: mode === "staff" ? "pointer" : "inherit" }}
        onPointerDown={onClefPointerDown}
        title={mode === "staff" ? "Tap the clef to switch treble / bass" : undefined}
      />
    </div>
  );
}

function drawStaff(
  ctx: CanvasRenderingContext2D, w: number, h: number, g: number, p: Palette,
  notes: readonly NoteEvent[], cur: NoteEvent | null,
  xOf: (n: NoteEvent) => number, alphaAt: (x: number) => number,
  clef: ClefKind, hit: { x: number; y: number; w: number; h: number },
) {
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

  const rx = g * 0.66, ry = g * 0.47;
  for (const n of notes) {
    const x = xOf(n);
    const a = alphaAt(x);
    if (a <= 0 || x > w) continue;

    let { p: pos, sharp } = staffPos(n.midi + 12, clef);
    let ottava = false;
    if (pos > 15) { pos -= 7; ottava = true; }
    const y = yOfPos(pos);
    const color = n === cur ? p.accent : p.ink;
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

    if (n === cur) { ctx.shadowColor = p.accent; ctx.shadowBlur = 8; }
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

function drawTab(
  ctx: CanvasRenderingContext2D, w: number, h: number, p: Palette,
  notes: readonly NoteEvent[], cur: NoteEvent | null,
  xOf: (n: NoteEvent) => number, alphaAt: (x: number) => number, headerW: number,
) {
  const s = clamp((h - 28) / 7.4, 7, 22);
  const top = (h - 5 * s) / 2;
  const yOfString = (str: number) => top + (5 - str) * s;   // high e on top
  const labelFs = clamp(s * 0.55, 9, 16);

  ctx.strokeStyle = p.dim;
  ctx.lineWidth = Math.max(0.8, s / 18);
  ctx.font = `600 ${labelFs}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let str = 0; str < 6; str++) {
    const y = yOfString(str);
    ctx.beginPath(); ctx.moveTo(headerW, y); ctx.lineTo(w - 4, y); ctx.stroke();
    ctx.fillStyle = p.dim;
    ctx.fillText(STRING_LABELS[str], headerW / 2 + 1, y);
  }

  const fs = clamp(s * 0.72, 9, 22);
  ctx.font = `700 ${fs}px monospace`;
  for (const n of notes) {
    if (n.string === null || n.fret === null) continue;
    const x = xOf(n);
    const a = alphaAt(x);
    if (a <= 0 || x > w) continue;
    const y = yOfString(n.string);
    const label = String(n.fret);
    const tw = ctx.measureText(label).width;

    // Knock the string line out behind the number
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = a;
    ctx.fillRect(x - tw / 2 - 2, y - fs / 2, tw + 4, fs);
    ctx.globalCompositeOperation = "source-over";

    ctx.globalAlpha = a;
    const isCur = n === cur;
    ctx.fillStyle = isCur ? p.accent : p.ink;
    if (isCur) { ctx.shadowColor = p.accent; ctx.shadowBlur = 8; }
    ctx.fillText(label, x, y + 0.5);
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
}
