/**
 * guideSynth
 *
 * A small additive piano that sounds out a guide take while it plays back.
 * Notes are given in performance.now() ms (as heard at the speaker) and are
 * scheduled a little ahead on the Web Audio clock, like the metronome's clicks.
 */

export interface SynthNote {
  at: number;        // performance.now() ms the note should be heard
  durMs: number;
  midi: number;
  velocity: number;  // 1–127
}

const LOOKAHEAD_MS = 200;
const TICK_MS = 25;
const LATE_MS = 40;          // a note this far past its time is skipped, not played late
const RELEASE_S = 0.16;      // damper coming down after the key is let go
const INHARMONICITY = 0.0004;
const MASTER_GAIN = 0.32;

interface Voice { gain: GainNode; oscs: AudioScheduledSourceNode[]; }

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let queue: SynthNote[] = [];
let next = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const voices = new Set<Voice>();

function ensureCtx(): AudioContext {
  if (!ctx || ctx.state === "closed") {
    ctx = new AudioContext({ latencyHint: "interactive" });
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(comp);
    noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.05), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

/** performance.now() ms at the speaker → AudioContext time. */
function perfToAudio(c: AudioContext, perf: number): number {
  const ts = c.getOutputTimestamp?.();
  if (ts?.contextTime && ts.performanceTime) return ts.contextTime + (perf - ts.performanceTime) / 1000;
  return c.currentTime + (perf - performance.now()) / 1000 - (c.outputLatency || c.baseLatency || 0);
}

function voice(c: AudioContext, out: AudioNode, n: SynthNote, t: number) {
  const f0 = 440 * Math.pow(2, (n.midi - 69) / 12);
  const vel = Math.min(1, Math.max(0.05, n.velocity / 127));
  // Low strings ring for longer
  const pitch = Math.min(1, Math.max(0, (n.midi - 36) / 60));
  const ring = 3.2 - pitch * 2.3;
  const held = Math.max(0.12, n.durMs / 1000);
  const end = t + Math.min(held, ring * 2.5);

  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.25 + vel * 0.75, t + 0.004);
  gain.gain.setTargetAtTime(0, end, RELEASE_S / 3);
  gain.connect(out);

  const oscs: AudioScheduledSourceNode[] = [];
  const stopAt = end + RELEASE_S * 2;
  const nyquist = c.sampleRate / 2 - 500;
  const partials = n.midi < 60 ? 9 : n.midi < 76 ? 7 : 5;
  for (let k = 1; k <= partials; k++) {
    const f = k * f0 * Math.sqrt(1 + INHARMONICITY * k * k);
    if (f > Math.min(nyquist, 9000)) break;
    // Harder hits are brighter; upper partials die away faster
    const amp = (1 / Math.pow(k, 1.35 - vel * 0.35)) * (k === 1 ? 0.9 : 1) * 0.3;
    const decay = ring / (1 + 0.7 * (k - 1));
    const osc = c.createOscillator();
    osc.frequency.value = f;
    osc.detune.value = (k % 2 ? 1 : -1) * 1.5;
    const env = c.createGain();
    env.gain.setValueAtTime(amp, t);
    env.gain.setTargetAtTime(amp * 0.12, t + 0.01, decay * 0.18);
    env.gain.setTargetAtTime(0, t + 0.25, decay);
    osc.connect(env).connect(gain);
    osc.start(t);
    osc.stop(stopAt);
    oscs.push(osc);
  }

  // Hammer thump
  if (noise) {
    const src = c.createBufferSource();
    src.buffer = noise;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = Math.min(4000, f0 * 4);
    bp.Q.value = 1.2;
    const env = c.createGain();
    env.gain.setValueAtTime(0.18 * vel, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    src.connect(bp).connect(env).connect(gain);
    src.start(t);
    src.stop(t + 0.05);
    oscs.push(src);
  }

  const v: Voice = { gain, oscs };
  voices.add(v);
  oscs[0].onended = () => { voices.delete(v); gain.disconnect(); };
}

function tick() {
  const c = ctx, out = master;
  if (!c || !out) return;
  const now = performance.now();
  while (next < queue.length && queue[next].at <= now + LOOKAHEAD_MS) {
    const n = queue[next++];
    if (n.at < now - LATE_MS) continue;
    voice(c, out, n, Math.max(c.currentTime, perfToAudio(c, n.at)));
  }
  if (next >= queue.length) halt();
}

function halt() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Replace whatever is playing with these notes. */
export function playNotes(notes: SynthNote[]) {
  stopNotes();
  if (notes.length === 0) return;
  ensureCtx();
  queue = [...notes].sort((a, b) => a.at - b.at);
  next = 0;
  tick();
  timer = setInterval(tick, TICK_MS);
}

/** Silence everything, including notes already ringing. */
export function stopNotes() {
  halt();
  queue = [];
  next = 0;
  if (!ctx) return;
  const t = ctx.currentTime;
  for (const v of voices) {
    const g = v.gain.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t); else g.cancelScheduledValues(t);
    g.setTargetAtTime(0, t, 0.015);
    for (const o of v.oscs) { try { o.stop(t + 0.1); } catch { /* already stopped */ } }
  }
}
