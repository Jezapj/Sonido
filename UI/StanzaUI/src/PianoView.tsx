/**
 * PianoView
 *
 * A keyboard with notes streaming to or from it. Live playing rises out of the
 * key it was played on; a loaded guide take falls and lights each key as it
 * lands. Optional 3D hands (handRig) follow whichever of the two is driving the keys.
 */

import { useEffect, useRef } from "react";
import { canvasStyle, drawTempo, fitCanvas, frameStyle, useRaf, usePalette } from "./NoteViews";
import { midiToName } from "./music";
import { getActiveNote, getNotes } from "./pitchTracker";
import { barMs } from "./rhythm";
import { HAND_TONES, HandRig, WHITE_KEY_M, type FingerGeom, type HandLook } from "./handRig";
import { getGuide, getLiveGrid, GUIDE_LEAD_MS, guideJudgement, guideTime, judgeGuide, meterOf } from "./takes";

// ── Keyboard layout ───────────────────────────────────────────────────────────

const LOW_MIDI = 40;    // E2, the guitar's lowest note
const HIGH_MIDI = 88;   // E6, just past the 22nd fret of the high e
const BLACK_PC = new Set([1, 3, 6, 8, 10]);
const isBlack = (midi: number) => BLACK_PC.has(((midi % 12) + 12) % 12);

const ROLL_MS = GUIDE_LEAD_MS;   // time a note takes to cross the roll
const MIN_BAR_H = 14;

interface Key { midi: number; x: number; w: number; black: boolean; white: number; }

interface Keyboard {
  id: string;
  lo: number;
  hi: number;
  u: number;        // white key width
  blackH: number;
  count: number;    // white keys
  keys: (Key | undefined)[];
  whites: HTMLCanvasElement;
  blacks: HTMLCanvasElement;
}

function layoutKeys(lo: number, hi: number, w: number) {
  let count = 0;
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) count++;
  const u = w / count;
  const keys: (Key | undefined)[] = [];
  let white = 0;
  for (let m = lo; m <= hi; m++) {
    if (isBlack(m)) {
      const bw = u * 0.62;
      keys[m] = { midi: m, x: white * u - bw / 2, w: bw, black: true, white: white - 0.5 };
    } else {
      keys[m] = { midi: m, x: white * u, w: u, black: false, white };
      white++;
    }
  }
  return { keys, u, count };
}

function layer(w: number, h: number, dpr: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  return { canvas, ctx };
}

/** Keys are drawn once per size into two layers, so a lit white key can go under the black ones. */
function buildKeyboard(w: number, keyH: number, lo: number, hi: number, dpr: number, id: string): Keyboard {
  const { keys, u, count } = layoutKeys(lo, hi, w);
  const blackH = keyH * 0.62;
  const whites = layer(w, keyH, dpr), blacks = layer(w, keyH, dpr);
  const fs = Math.min(10, u * 0.56);

  whites.ctx.textAlign = "center";
  whites.ctx.textBaseline = "bottom";
  for (let m = lo; m <= hi; m++) {
    const k = keys[m];
    if (!k) continue;
    if (k.black) {
      const c = blacks.ctx;
      const g = c.createLinearGradient(0, 0, 0, blackH);
      g.addColorStop(0, "#14141b");
      g.addColorStop(0.82, "#26262f");
      g.addColorStop(0.83, "#3a3a46");
      g.addColorStop(1, "#191920");
      c.fillStyle = g;
      c.beginPath();
      c.roundRect(k.x, 0, k.w, blackH, [0, 0, 2, 2]);
      c.fill();
      c.fillStyle = "rgba(255,255,255,0.1)";
      c.fillRect(k.x + 1, 0, 1, blackH * 0.8);
    } else {
      const c = whites.ctx;
      const g = c.createLinearGradient(0, 0, 0, keyH);
      g.addColorStop(0, "#c9c9d2");
      g.addColorStop(0.3, "#ececf2");
      g.addColorStop(0.94, "#f6f6fa");
      g.addColorStop(0.95, "#b9b9c4");
      g.addColorStop(1, "#a2a2ae");
      c.fillStyle = g;
      c.beginPath();
      c.roundRect(k.x + 0.5, 0, k.w - 1, keyH, [0, 0, 2.5, 2.5]);
      c.fill();
      if (fs >= 6) {
        c.font = `600 ${fs}px monospace`;
        c.fillStyle = "rgba(40,40,60,0.55)";
        c.fillText(midiToName(m, false), k.x + k.w / 2, keyH - 3);
      }
    }
  }
  return { id, lo, hi, u, blackH, count, keys, whites: whites.canvas, blacks: blacks.canvas };
}

// ── Colour ────────────────────────────────────────────────────────────────────

const HIT_HUE = 152, MISS_HUE = 0, LIVE_OVER_GUIDE_HUE = 248;

/** Low notes blue, through magenta, high notes orange (most guitar playing is the lower three octaves). */
const pitchHue = (midi: number) => 205 + Math.min(1, Math.max(0, (midi - LOW_MIDI) / 36)) * 185;
const hsla = (h: number, s: number, l: number, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

// ── Hands ─────────────────────────────────────────────────────────────────────

const HAND_REACH = 1.6;          // keys either side of the hand's centre it can cover without moving
const REST_TIP = 0.24;           // where the fingertips rest, as a fraction down the keys
const REST_SPAN = 0.64;          // how much of a finger's length shows on screen at rest
const MIDDLE = 2;

interface Tip { x: number; y: number; press: number; hue: number; }

interface Hand {
  side: 1 | -1;     // 1: right hand (thumb towards the low notes)
  centre: number;   // white keys
  target: number;
  tips: Tip[];
}

const newHand = (side: 1 | -1, centre: number): Hand => ({
  side, centre, target: centre,
  tips: Array.from({ length: 5 }, () => ({ x: NaN, y: NaN, press: 0, hue: 0 })),
});

interface HandNote { key: Key; pressed: boolean; hue: number; }

const easeRate = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);

interface HandScale {
  scale: number;      // pixels per metre
  span: number;       // a life-size white key at that scale (the keys can be wider in a small card)
  knuckleY: number;
}

/** Life-size against the keys where the card is tall enough for that, otherwise fitted to it. */
function handScale(u: number, keyTop: number, keyH: number, geom: FingerGeom[]): HandScale {
  const span = Math.min(u, (keyH / 0.105) * WHITE_KEY_M);
  const scale = span / WHITE_KEY_M;
  const knuckleY = keyTop + keyH * REST_TIP + geom[MIDDLE].length * scale * REST_SPAN;
  return { scale, span, knuckleY };
}

/** Move a hand so it covers its notes, and put a free finger on each. */
function poseHand(
  hand: Hand, notes: HandNote[], dt: number, kb: Keyboard, keyTop: number, keyH: number,
  fit: HandScale, geom: FingerGeom[],
) {
  const { u } = kb;
  const ratio = fit.span / u;
  if (notes.length) {
    const xs = notes.map(n => n.key.white);
    const lo = Math.min(...xs), hi = Math.max(...xs);
    // Shift so the note lands under an inner finger, not at full stretch
    if (hi > hand.target + HAND_REACH * ratio) hand.target = hi - ratio;
    if (lo < hand.target - HAND_REACH * ratio) hand.target = lo + ratio;
  }
  hand.centre += (hand.target - hand.centre) * easeRate(dt, 15);

  const taken: (HandNote | undefined)[] = [];
  for (const n of [...notes].sort((a, b) => a.key.white - b.key.white)) {
    const offset = hand.side * (n.key.white - hand.target) / ratio;
    const ideal = Math.max(n.key.black ? 1 : 0, Math.min(4, Math.round(offset + 2)));
    let finger = -1;
    for (const d of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      const f = ideal + d;
      if (f >= 0 && f <= 4 && !taken[f]) { finger = f; break; }
    }
    if (finger >= 0) taken[finger] = n;
  }

  const homeX = (hand.centre + 0.5) * u;
  for (let f = 0; f < 5; f++) {
    const tip = hand.tips[f], n = taken[f], g = geom[f];
    let tx = homeX + hand.side * (f - 2) * fit.span;
    let ty = fit.knuckleY + (g.baseY - g.length * REST_SPAN) * fit.scale;
    if (f === 0) { tx = homeX - hand.side * 2.7 * fit.span; ty = fit.knuckleY - 0.25 * fit.span; }
    let press = 0;
    if (n) {
      // While the hand is still travelling, a finger only reaches as far as a real one could
      const reach = 3.1 * fit.span;
      tx = Math.max(homeX - reach, Math.min(homeX + reach, n.key.x + n.key.w / 2));
      ty = Math.min(ty, keyTop + (n.key.black ? kb.blackH * 0.55 : keyH * 0.4));
      if (n.pressed) { press = 1; ty -= keyH * 0.03; }
      tip.hue = n.hue;
    }
    if (Number.isNaN(tip.x)) { tip.x = tx; tip.y = ty; }
    const k = easeRate(dt, n ? 34 : 14);
    tip.x += (tx - tip.x) * k;
    tip.y += (ty - tip.y) * k;
    tip.press += (press - tip.press) * easeRate(dt, 30);
  }
}

/** Glow where a finger is pressing. */
function drawPressGlow(ctx: CanvasRenderingContext2D, tips: Tip[], u: number) {
  ctx.globalCompositeOperation = "lighter";
  for (const tip of tips) {
    if (tip.press < 0.03) continue;
    const r = u * 1.5;
    const g = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, r);
    g.addColorStop(0, hsla(tip.hue, 95, 70, 0.55 * tip.press));
    g.addColorStop(1, hsla(tip.hue, 95, 60, 0));
    ctx.fillStyle = g;
    ctx.fillRect(tip.x - r, tip.y - r, r * 2, r * 2);
  }
  ctx.globalCompositeOperation = "source-over";
}

// ── View ──────────────────────────────────────────────────────────────────────

interface Spark { x: number; y: number; vx: number; vy: number; life: number; fade: number; hue: number; }

const MAX_SPARKS = 220;

interface PianoState {
  kb: Keyboard | null;
  glow: Float32Array;   // per MIDI note: 1 while held, fading after
  hue: Float32Array;
  wasOn: Uint8Array;
  sparks: Spark[];
  last: number;
  left: Hand;
  right: Hand;
}

const newState = (): PianoState => ({
  kb: null,
  glow: new Float32Array(128),
  hue: new Float32Array(128),
  wasOn: new Uint8Array(128),
  sparks: [],
  last: 0,
  left: newHand(-1, 7),
  right: newHand(1, 19),
});

function emit(st: PianoState, k: Key, keyTop: number, hue: number, count: number, strength: number) {
  for (let i = 0; i < count && st.sparks.length < MAX_SPARKS; i++) {
    st.sparks.push({
      x: k.x + Math.random() * k.w,
      y: keyTop - 1,
      vx: (Math.random() - 0.5) * 70 * strength,
      vy: -(40 + Math.random() * 170) * strength,
      life: 1,
      fade: 0.9 + Math.random() * 1.5,
      hue: hue + (Math.random() - 0.5) * 30,
    });
  }
}

function drawNoteBar(
  ctx: CanvasRenderingContext2D, k: Key, top: number, bottom: number, hue: number,
  lit: boolean, label: string, labelY: number,
) {
  const w = Math.max(k.w - 2, 11);
  const x = k.x + k.w / 2 - w / 2;
  const h = bottom - top;
  const r = Math.min(4, w / 3);
  const g = ctx.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0, hsla(hue, 92, lit ? 72 : 62));
  g.addColorStop(1, hsla(hue + 14, 95, lit ? 62 : 50));

  ctx.shadowColor = hsla(hue, 100, 62, lit ? 1 : 0.65);
  ctx.shadowBlur = lit ? 22 : 9;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(x, top, w, h, r);
  ctx.fill();
  ctx.shadowBlur = 0;

  if (lit) {
    // Hot core, as if the bar were a neon tube
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "rgba(255,255,255,0.42)";
    ctx.beginPath();
    ctx.roundRect(x + w * 0.28, top + 1, w * 0.44, Math.max(0, h - 2), r);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.strokeStyle = lit ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x + 0.5, top + 0.5, w - 1, Math.max(0, h - 1), r);
  ctx.stroke();

  ctx.font = `700 ${Math.max(9, Math.min(13, w * 0.68))}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 3;
  ctx.fillText(label, x + w / 2, labelY);
  ctx.shadowBlur = 0;
}

/** Lay out the bar and pin its label just inside the end leading the way. */
function placeBar(
  ctx: CanvasRenderingContext2D, k: Key, top: number, bottom: number, leadTop: boolean,
  hue: number, lit: boolean, midi: number,
) {
  if (bottom - top < MIN_BAR_H) {
    if (leadTop) top = bottom - MIN_BAR_H; else bottom = top + MIN_BAR_H;
  }
  drawNoteBar(ctx, k, top, bottom, hue, lit, midiToName(midi, false), leadTop ? top + 9 : bottom - 9);
}

const SWATCH_RING = "rgba(255,255,255,0.5)";

/** The HANDS switch and, while on, the choice of outline or a skin tone. */
export function PianoHandControls({ on, look, onToggle, onLook, base, accent }: {
  on: boolean;
  look: HandLook;
  onToggle: () => void;
  onLook: (look: HandLook) => void;
  base: React.CSSProperties;
  accent: string;
}) {
  const looks = ["outline", ...Object.keys(HAND_TONES)] as HandLook[];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <button
        type="button"
        onClick={onToggle}
        title={on ? "Hide the hands" : "Show the hands"}
        style={{
          ...base,
          fontSize: 9, letterSpacing: "0.08em", padding: "2px 7px",
          ...(on && { borderColor: accent, color: accent, background: "rgba(175,169,236,0.12)" }),
        }}
      >
        HANDS
      </button>
      {on && looks.map(l => (
        <button
          key={l}
          type="button"
          onClick={() => onLook(l)}
          title={l === "outline" ? "Outline" : `${l[0].toUpperCase()}${l.slice(1)} skin tone`}
          aria-label={l === "outline" ? "Outline hands" : `${l} skin tone`}
          aria-pressed={look === l}
          style={{
            width: 12, height: 12, padding: 0, borderRadius: "50%", cursor: "pointer", flexShrink: 0,
            background: l === "outline" ? "transparent" : HAND_TONES[l],
            border: l === "outline" ? "1.5px solid #7a5cff" : "none",
            boxShadow: look === l ? `0 0 0 1.5px ${accent}` : `0 0 0 0.5px ${SWATCH_RING}`,
          }}
        />
      ))}
    </div>
  );
}

/** `hands`: how to draw them, or null for none. */
export function PianoView({ active, hands }: { active: boolean; hands: HandLook | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const rigRef = useRef<HandRig | null>(null);
  const pal = usePalette();
  const stateRef = useRef<PianoState>(newState());
  const handsRef = useRef(hands);
  handsRef.current = hands;

  // WebGL only exists while the hands are showing
  const showHands = hands !== null;
  useEffect(() => {
    if (!showHands) return;
    const rig = new HandRig();
    frameRef.current?.appendChild(rig.canvas);
    rig.load().catch(e => console.warn("[piano] could not load the hand models:", e));
    rigRef.current = rig;
    return () => { rig.dispose(); rigRef.current = null; };
  }, [showHands]);

  useRaf(active, () => {
    const fit = fitCanvas(canvasRef.current);
    if (!fit) return;
    const { ctx, w, h } = fit;
    const st = stateRef.current;
    const now = performance.now();
    const dt = st.last ? Math.min(0.05, (now - st.last) / 1000) : 0;
    st.last = now;

    const live = getNotes();
    const cur = getActiveNote();
    const guide = getGuide();
    const gt = guide ? guideTime(now) : 0;
    if (guide) judgeGuide(live, now);

    // Fits the guitar's range, widened for an imported take that goes past it
    let lo = LOW_MIDI, hi = HIGH_MIDI;
    if (guide) for (const n of guide.notes) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
    if (isBlack(lo)) lo--;
    if (isBlack(hi)) hi++;

    const keyH = Math.round(Math.min(170, Math.max(46, h * 0.4)));
    const keyTop = h - keyH;
    const dpr = window.devicePixelRatio || 1;
    const id = `${w}|${keyH}|${lo}|${hi}|${dpr}`;
    if (st.kb?.id !== id) st.kb = buildKeyboard(w, keyH, lo, hi, dpr, id);
    const kb = st.kb;
    const pps = keyTop / (ROLL_MS / 1000);

    // Backdrop
    const bg = ctx.createLinearGradient(0, 0, 0, keyTop);
    bg.addColorStop(0, "#07060d");
    bg.addColorStop(1, "#14102a");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, keyTop);
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let m = lo; m <= hi; m++) {
      if (((m % 12) + 12) % 12 !== 0) continue;
      const x = Math.round((kb.keys[m]?.x ?? 0)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, keyTop); ctx.stroke();
    }

    // Bar lines cross the roll with the notes
    const meter = guide ? meterOf(guide) : null;
    const grid = guide ? null : getLiveGrid();
    const m = meter ?? grid?.meter ?? null;
    if (m) {
      const bMs = barMs(m);
      const at = meter ? gt : now;
      const yOf = (t: number) => keyTop - ((meter ? t - at : at - t) / 1000) * pps;
      const from = Math.max(0, Math.floor((at - ROLL_MS - m.downbeatMs) / bMs));
      const to = Math.ceil((at + ROLL_MS - m.downbeatMs) / bMs);
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      for (let k = from; k <= to; k++) {
        const y = Math.round(yOf(m.downbeatMs + k * bMs)) + 0.5;
        if (y < 0 || y > keyTop) continue;
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.fillText(String(k + 1), 4, y - 1);
      }
    }

    // What the keys are doing this frame
    const on = new Map<number, number>();         // midi → hue
    const handNotes: { midi: number; pressed: boolean; hue: number }[] = [];
    let split = 60;

    if (guide) {
      const sorted = guide.notes.map(n => n.midi).sort((a, b) => a - b);
      if (sorted.length) split = sorted[sorted.length >> 1];
      guide.notes.forEach((n, i) => {
        const sounding = gt >= n.startMs && gt < n.startMs + n.durMs;
        const coming = n.startMs > gt && n.startMs - gt < 260;
        if (!sounding && !coming) return;
        const j = guideJudgement(i);
        const hue = sounding && j === 1 ? HIT_HUE : sounding && j === 0 ? MISS_HUE : pitchHue(n.midi);
        if (sounding) on.set(n.midi, hue);
        handNotes.push({ midi: n.midi, pressed: sounding, hue });
      });
      if (cur && !on.has(cur.midi)) on.set(cur.midi, LIVE_OVER_GUIDE_HUE);
    } else if (cur) {
      on.set(cur.midi, pitchHue(cur.midi));
      handNotes.push({ midi: cur.midi, pressed: true, hue: pitchHue(cur.midi) });
    }

    for (let n = 0; n < 128; n++) {
      const hue = on.get(n);
      if (hue !== undefined) {
        st.hue[n] = hue;
        st.glow[n] = 1;
        const k = kb.keys[n];
        if (k) {
          if (!st.wasOn[n]) emit(st, k, keyTop, hue, 18, 1.15);
          else if (Math.random() < dt * 34) emit(st, k, keyTop, hue, 1, 0.75);
        }
        st.wasOn[n] = 1;
      } else {
        st.wasOn[n] = 0;
        st.glow[n] = Math.max(0, st.glow[n] - dt * 3.6);
      }
    }

    // Light columns above the lit keys
    ctx.globalCompositeOperation = "lighter";
    for (let n = lo; n <= hi; n++) {
      const g = st.glow[n], k = kb.keys[n];
      if (g <= 0 || !k) continue;
      const beam = ctx.createLinearGradient(0, keyTop, 0, keyTop * 0.15);
      beam.addColorStop(0, hsla(st.hue[n], 95, 62, 0.34 * g));
      beam.addColorStop(1, hsla(st.hue[n], 95, 62, 0));
      ctx.fillStyle = beam;
      ctx.fillRect(k.x - k.w * 0.3, 0, k.w * 1.6, keyTop);
    }
    ctx.globalCompositeOperation = "source-over";

    // Notes: clipped at the key line so they appear to come out of / sink into it
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, keyTop);
    ctx.clip();
    if (guide) {
      guide.notes.forEach((n, i) => {
        const k = kb.keys[n.midi];
        if (!k) return;
        const bottom = keyTop - ((n.startMs - gt) / 1000) * pps;
        const top = keyTop - ((n.startMs + n.durMs - gt) / 1000) * pps;
        if (bottom < 0 || top > keyTop) return;
        const j = guideJudgement(i);
        const hue = j === 1 ? HIT_HUE : j === 0 ? MISS_HUE : pitchHue(n.midi);
        placeBar(ctx, k, top, bottom, false, hue, gt >= n.startMs && gt < n.startMs + n.durMs, n.midi);
      });
    } else {
      for (let i = live.length - 1; i >= 0; i--) {
        const n = live[i];
        const bottom = keyTop - ((now - (n.end ?? now)) / 1000) * pps;
        const top = keyTop - ((now - n.start) / 1000) * pps;
        if (bottom < 0) break;
        const k = kb.keys[n.midi];
        if (k) placeBar(ctx, k, top, bottom, true, pitchHue(n.midi), n === cur, n.midi);
      }
    }
    ctx.restore();

    // Keys: whites, their highlights, then blacks over them
    ctx.drawImage(kb.whites, 0, keyTop, w, keyH);
    const litKey = (k: Key, n: number, g: number) => {
      const keyLen = k.black ? kb.blackH : keyH;
      const fill = ctx.createLinearGradient(0, keyTop, 0, keyTop + keyLen);
      fill.addColorStop(0, hsla(st.hue[n], 96, 66, g));
      fill.addColorStop(1, hsla(st.hue[n], 96, k.black ? 46 : 58, 0.75 * g));
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(k.x + 0.5, keyTop, k.w - 1, keyLen, [0, 0, 2.5, 2.5]);
      ctx.fill();
      const fs = Math.min(12, k.w * (k.black ? 0.8 : 0.62));
      if (fs < 6) return;
      ctx.globalAlpha = g;
      ctx.font = `700 ${fs}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "#fff";
      ctx.fillText(midiToName(n, false), k.x + k.w / 2, keyTop + keyLen - 3);
      ctx.globalAlpha = 1;
    };
    for (let n = lo; n <= hi; n++) {
      const k = kb.keys[n];
      if (k && !k.black && st.glow[n] > 0) litKey(k, n, st.glow[n]);
    }
    ctx.drawImage(kb.blacks, 0, keyTop, w, keyH);
    for (let n = lo; n <= hi; n++) {
      const k = kb.keys[n];
      if (k && k.black && st.glow[n] > 0) litKey(k, n, st.glow[n]);
    }

    // The glowing lip along the top of the keys, flaring at each lit key
    const lip = ctx.createLinearGradient(0, 0, w, 0);
    lip.addColorStop(0, "#7c6cff");
    lip.addColorStop(0.5, "#e7c6ff");
    lip.addColorStop(1, "#ff9ec7");
    ctx.shadowColor = "#b49bff";
    ctx.shadowBlur = 8;
    ctx.fillStyle = lip;
    ctx.fillRect(0, keyTop - 1, w, 2);
    ctx.shadowBlur = 0;

    ctx.globalCompositeOperation = "lighter";
    for (let n = lo; n <= hi; n++) {
      const g = st.glow[n], k = kb.keys[n];
      if (g <= 0 || !k) continue;
      const cx = k.x + k.w / 2, r = Math.max(26, k.w * 3);
      const flare = ctx.createRadialGradient(cx, keyTop, 0, cx, keyTop, r);
      flare.addColorStop(0, hsla(st.hue[n], 100, 76, 0.85 * g));
      flare.addColorStop(0.35, hsla(st.hue[n], 100, 62, 0.34 * g));
      flare.addColorStop(1, hsla(st.hue[n], 100, 60, 0));
      ctx.fillStyle = flare;
      ctx.fillRect(cx - r, keyTop - r, r * 2, r * 2);
    }

    // Sparks
    const alive: Spark[] = [];
    for (const s of st.sparks) {
      s.life -= dt * s.fade;
      if (s.life <= 0) continue;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 55 * dt;
      s.vx *= 1 - dt * 1.4;
      alive.push(s);
      if (s.y > keyTop) continue;
      ctx.globalAlpha = Math.min(1, s.life * 1.3);
      ctx.fillStyle = hsla(s.hue, 100, 74);
      const size = 1 + s.life * 1.5;
      ctx.fillRect(s.x - size / 2, s.y - size / 2, size, size);
    }
    st.sparks = alive;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    const look = handsRef.current, rig = rigRef.current, rigGeom = rig?.geometry;
    if (look && rig && rigGeom) {
      const { left, right } = st;
      const toHand = (want: (midi: number) => boolean) => handNotes.flatMap(n => {
        const key = kb.keys[n.midi];
        return key && want(n.midi) ? [{ key, pressed: n.pressed, hue: n.hue }] : [];
      });
      const lNotes = toHand(n => n < split), rNotes = toHand(n => n >= split);
      const fit = handScale(kb.u, keyTop, keyH, rigGeom.right);

      // Hands make room for each other instead of overlapping
      const GAP = 5.4 * (fit.span / kb.u);
      poseHand(left, lNotes, dt, kb, keyTop, keyH, fit, rigGeom.left);
      poseHand(right, rNotes, dt, kb, keyTop, keyH, fit, rigGeom.right);
      if (left.target > right.target - GAP) {
        if (lNotes.length && !rNotes.length) right.target = left.target + GAP;
        else left.target = right.target - GAP;
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, keyTop - 2, w, keyH + 2);
      ctx.clip();
      drawPressGlow(ctx, [...left.tips, ...right.tips], kb.u);
      ctx.restore();

      const pose = (hand: Hand) => ({ x: (hand.centre + 0.5) * kb.u, tips: hand.tips });
      rig.render({
        w, top: keyTop - 2, h, dpr, scale: fit.scale, knuckleY: fit.knuckleY,
        left: pose(left), right: pose(right), look,
      });
    }

    if (meter) drawTempo(ctx, w, "#F5B971", meter);
    else if (grid) drawTempo(ctx, w, "#AFA9EC", grid.meter);

    if (!guide && live.length === 0) {
      ctx.font = "11px monospace";
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("play a note…", w / 2, keyTop / 2);
    }
  });

  return (
    <div ref={frameRef} style={{ ...frameStyle(pal.current), background: "#07060d" }}>
      <canvas ref={canvasRef} style={canvasStyle} />
    </div>
  );
}
