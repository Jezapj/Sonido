import { useRef, useState, useCallback, useEffect } from "react";
import { useSerialStream } from "./useSerialStream";
import { useIsLightMode } from "./UseTheme";
import DashboardMetronome from "./DashboardMetronome";
import DashboardChordBank from "./DashboardChordBank";
import { getLastNote, SAMPLE_RATE, startPitchTracker } from "./pitchTracker";
import { midiToName } from "./music";
import DashboardTuner from "./DashboardTuner";

const BUFFER_LEN  = 4096;
const MAX_DISPLAY_HZ = 4000;

type FftRes = "low" | "normal" | "high";
type FftPace = "fast" | "normal" | "slow";

/** Displayed bars. High keeps one bar per FFT bin, which is the original view. */
const RES_BARS: Record<FftRes, number | null> = { low: 24, normal: 72, high: null };
/** How quickly a bar chases the new magnitude. Fast is the original, unsmoothed draw. */
const PACE_ALPHA: Record<FftPace, number> = { fast: 1, normal: 0.22, slow: 0.07 };

const RES_OPTIONS: { id: FftRes; label: string }[] = [
  { id: "low", label: "LOW" },
  { id: "normal", label: "NORMAL" },
  { id: "high", label: "HIGH" },
];
const PACE_OPTIONS: { id: FftPace; label: string }[] = [
  { id: "fast", label: "FAST" },
  { id: "normal", label: "NORMAL" },
  { id: "slow", label: "SLOW" },
];

const PANEL_COUNT = 4;
const PANEL_W = 300;
const SWIPE_THRESHOLD = 48;
/** Empty space between panels, so a neighbour can never show at the carousel's edge. */
const PANEL_GAP = 24;
/** On-screen size of the songs panel when focused; the rest of the zoom becomes extra room. */
const SONGS_ZOOM = 1.7;

const wrapPage = (p: number) => ((p % PANEL_COUNT) + PANEL_COUNT) % PANEL_COUNT;

const PANEL_LABELS = ["FFT", "SONGS", "METRO", "TUNER"];

function fft(re: Float32Array, im: Float32Array) {
  const N = re.length;
  for (let i = 0, j = 0; i < N; i++) {
    if (j > i) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
    let m = N >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = Math.PI * 2 / size;
    for (let i = 0; i < N; i += size) {
      for (let j = 0; j < half; j++) {
        const k    = j * step;
        const cos  = Math.cos(k), sin = -Math.sin(k);
        const tpre = re[i+j+half]*cos - im[i+j+half]*sin;
        const tpim = re[i+j+half]*sin + im[i+j+half]*cos;
        re[i+j+half] = re[i+j] - tpre; im[i+j+half] = im[i+j] - tpim;
        re[i+j] += tpre; im[i+j] += tpim;
      }
    }
  }
}

const btnBaseDark: React.CSSProperties = {
  background: "transparent",
  border: "0.5px solid rgba(255,255,255,0.25)",
  color: "#ffffff",
  borderRadius: 8,
  padding: "4px 10px",
  fontSize: 11,
  fontFamily: "monospace",
  cursor: "pointer",
  letterSpacing: "0.04em",
  transition: "background 0.15s, border-color 0.15s, color 0.15s",
  whiteSpace: "nowrap" as const,
};

const btnBaseLight: React.CSSProperties = {
  ...btnBaseDark,
  border: "0.5px solid rgba(0,0,0,0.22)",
  color: "#1a0f2e",
};

function FftOptionRow<T extends string>({
  caption, value, options, onChange, btnBase, accent, light,
}: {
  caption: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
  btnBase: React.CSSProperties;
  accent: string;
  light: boolean;
}) {
  return (
    <div className="da-fft-opt">
      <span className="da-label">{caption}</span>
      <div className="da-fft-opt-btns">
        {options.map(opt => {
          const on = opt.id === value;
          return (
            <button
              key={opt.id}
              type="button"
              className={on ? "is-on" : undefined}
              onClick={() => onChange(opt.id)}
              style={{
                ...btnBase,
                flex: 1,
                padding: "3px 0",
                fontSize: 10,
                fontWeight: on ? 700 : 500,
                borderColor: on ? accent : undefined,
                color: on ? accent : undefined,
                background: on
                  ? (light ? "rgba(109,40,217,0.12)" : "rgba(175,169,236,0.2)")
                  : "transparent",
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function DashboardAudio({ focused = false }: { focused?: boolean }) {
  const light = useIsLightMode();
  const btnBase = light ? btnBaseLight : btnBaseDark;
  const accent = light ? "#6d28d9" : "#AFA9EC";
  const muted = light ? "rgba(26,15,46,0.45)" : "rgba(255,255,255,0.45)";
  const rootColor = light ? "#1a0f2e" : "white";

  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const bufferRef   = useRef<Float32Array>(new Float32Array(BUFFER_LEN));
  const smoothRef   = useRef<Float32Array>(new Float32Array(0));
  const animRef     = useRef(0);
  const runningRef  = useRef(false);
  const [note, setNote] = useState("—");
  const [fftRes, setFftRes] = useState<FftRes>("normal");
  const [fftPace, setFftPace] = useState<FftPace>("normal");
  const fftResRef = useRef(fftRes);
  const fftPaceRef = useRef(fftPace);
  useEffect(() => { fftResRef.current = fftRes; }, [fftRes]);
  useEffect(() => { fftPaceRef.current = fftPace; }, [fftPace]);

  useEffect(() => { startPitchTracker(); }, []);

  // ── Carousel ───────────────────────────────────────────────────────────────
  // `pos` counts steps and never wraps, so tuner → FFT is one more step along the track
  const [pos, setPos] = useState(0);
  const [fromPos, setFromPos] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartX = useRef(0);
  const posRef = useRef(0);
  const page = wrapPage(pos);

  const moveTo = (next: number) => {
    setFromPos(posRef.current);
    setPos(next);
    posRef.current = next;
  };

  // ── Focus zoom: scale the fixed-width panel up to fill the focused card ────
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState<{ w: number; h: number } | null>(null);   // carousel size when focused
  const zoomRef = useRef(1);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  useEffect(() => {
    if (!focused) { setZoom(1); setView(null); return; }
    const root = rootRef.current;
    const header = headerRef.current;
    const parent = root?.parentElement;
    if (!root || !header || !parent) return;
    const fit = () => {
      // offset* sizes ignore transforms. Only the fixed-size panels set the zoom: the
      // songs panel grows to fill whatever room they leave.
      let content = 0;
      root.querySelectorAll<HTMLElement>("[data-fixed-panel]").forEach(el => {
        content = Math.max(content, el.offsetHeight);
      });
      const headerH = header.offsetHeight + 4;
      if (!content) return;
      const roomW = parent.clientWidth - 24, roomH = parent.clientHeight - 8;
      const next = Math.max(1, Math.min(roomW / PANEL_W, roomH / (headerH + content)));
      if (Math.abs(next - zoomRef.current) > 0.01) { zoomRef.current = next; setZoom(next); }
      const w = Math.max(PANEL_W, roomW / zoomRef.current);
      const h = Math.max(content, roomH / zoomRef.current - headerH);
      setView(v => (v && Math.abs(v.w - w) < 0.5 && Math.abs(v.h - h) < 0.5 ? v : { w, h }));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(parent);
    ro.observe(root);
    return () => ro.disconnect();
  }, [focused]);
  const fftScale = zoom > 1 ? zoom * (window.devicePixelRatio || 1) : 1;

  const ingestChunk = useCallback((samples: number[]) => {
    let energy = 0;
    for (const s of samples) energy += s * s;
    if (energy / samples.length < 1e-6) return;
    const buf = bufferRef.current;
    const len = samples.length;
    if (len >= BUFFER_LEN) buf.set(samples.slice(len - BUFFER_LEN));
    else { buf.copyWithin(0, len); buf.set(samples, BUFFER_LEN - len); }
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height;

    const re = new Float32Array(bufferRef.current);
    const im = new Float32Array(BUFFER_LEN);
    fft(re, im);

    const mags = new Float32Array(BUFFER_LEN / 2);
    for (let i = 0; i < mags.length; i++) mags[i] = Math.sqrt(re[i]**2 + im[i]**2);

    const last = getLastNote();
    setNote(last ? midiToName(last.midi) : "—");

    const displayBins = Math.min(
      mags.length,
      Math.ceil(MAX_DISPLAY_HZ * BUFFER_LEN / SAMPLE_RATE),
    );
    const cap = RES_BARS[fftResRef.current];
    const bars = cap == null ? displayBins : Math.min(displayBins, cap);
    const alpha = PACE_ALPHA[fftPaceRef.current];

    let shown = smoothRef.current;
    if (shown.length !== bars) {
      shown = new Float32Array(bars);
      smoothRef.current = shown;
    }
    for (let b = 0; b < bars; b++) {
      const start = Math.floor(b * displayBins / bars);
      const end = Math.max(start + 1, Math.floor((b + 1) * displayBins / bars));
      let sum = 0;
      for (let i = start; i < end; i++) sum += mags[i];
      const target = sum / (end - start);
      shown[b] = shown[b] + alpha * (target - shown[b]);
    }

    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 0.5;
    for (let hz = 500; hz < MAX_DISPLAY_HZ; hz += 500) {
      const x = (hz / MAX_DISPLAY_HZ) * W;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }

    const barWidth = W / bars;
    const gap = cap == null ? 0 : 1;
    for (let i = 0; i < bars; i++) {
      const h = (shown[i] / 50) * H;
      ctx.fillStyle = "#00ffcc";
      ctx.fillRect(i * barWidth, H - h, Math.max(barWidth - gap, 1), h);
    }

    if (runningRef.current) animRef.current = requestAnimationFrame(draw);
  }, []);

  const onChunk = useCallback((samples: number[]) => {
    ingestChunk(samples);
    if (!runningRef.current) {
      runningRef.current = true;
      animRef.current = requestAnimationFrame(draw);
    }
  }, [ingestChunk, draw]);

  const { connected } = useSerialStream(onChunk);

  useEffect(() => {
    if (connected) return;
    runningRef.current = false;
    cancelAnimationFrame(animRef.current);
    bufferRef.current.fill(0);
    smoothRef.current = new Float32Array(0);
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setNote("—");
  }, [connected]);

  // ── Carousel swipe (loops) ─────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    // Don't steal drags from sliders / buttons / the songs list (folder DnD)
    const el = e.target as HTMLElement;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (el.closest(".da-chords")) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStartX.current = e.clientX;
    setFromPos(posRef.current);
    setDragging(true);
    setDragX(0);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragX((e.clientX - dragStartX.current) / zoomRef.current);
  };

  const finishDrag = (clientX: number) => {
    if (!dragging) return;
    const dx = clientX - dragStartX.current;
    if (dx <= -SWIPE_THRESHOLD) moveTo(posRef.current + 1);
    else if (dx >= SWIPE_THRESHOLD) moveTo(posRef.current - 1);
    setDragX(0);
    setDragging(false);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    finishDrag(e.clientX);
  };

  const goPage = (dir: -1 | 1) => moveTo(posRef.current + dir);

  /** Dots take the short way round too. */
  const goToPanel = (i: number) => {
    const d = wrapPage(i - page);
    moveTo(posRef.current + (d > PANEL_COUNT / 2 ? d - PANEL_COUNT : d));
  };

  const viewW = view?.w ?? PANEL_W;
  const step = viewW + PANEL_GAP;
  const trackOffset = -pos * step + (dragging ? dragX : 0);

  // Each panel sits on whichever lap of the track is closest to where we are (and
  // were), so the panel either side of the current one is always its real neighbour.
  // Panels hold live state, so they move rather than being duplicated.
  const lapCentre = (pos + fromPos) / 2;
  const panelStyle = (i: number): React.CSSProperties => ({
    width: viewW,
    flexShrink: 0,
    display: "flex",
    justifyContent: "center",
    alignItems: focused ? "center" : "flex-start",
    transform: `translateX(${Math.round((lapCentre - i) / PANEL_COUNT) * PANEL_COUNT * step}px)`,
  });

  const songsScale = view ? Math.max(1, zoom / SONGS_ZOOM) : 1;

  return (
    <div
      ref={rootRef}
      className="da-root"
      style={focused
        ? { position: "relative", margin: "auto", transform: `scale(${zoom})`, flexShrink: 0, color: rootColor }
        : { position: "absolute", bottom: 0, left: 10, color: rootColor }}
    >
      <div ref={headerRef} style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        width: PANEL_W, margin: "0 auto 4px",
      }}>
        <button type="button" onClick={() => goPage(-1)} style={{ ...btnBase }}>‹</button>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="da-label" style={{
            fontFamily: "monospace", fontSize: 10, letterSpacing: "0.12em",
            color: muted,
          }}>
            {PANEL_LABELS[page]}
          </span>
          <div style={{ display: "flex", gap: 5 }}>
            {PANEL_LABELS.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => goToPanel(i)}
                aria-label={`Go to ${PANEL_LABELS[i]}`}
                style={{
                  width: 6, height: 6, borderRadius: "50%", padding: 0, border: "none",
                  cursor: "pointer",
                  background: i === page ? accent : (light ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.25)"),
                  boxShadow: i === page ? `0 0 6px ${accent}` : "none",
                }}
              />
            ))}
          </div>
        </div>
        <button type="button" onClick={() => goPage(1)} style={{ ...btnBase }}>›</button>
      </div>

      <div
        className="da-carousel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          width: viewW,
          height: view?.h,
          overflow: "hidden",
          touchAction: "pan-y",
          cursor: dragging ? "grabbing" : "grab",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: PANEL_GAP,
            width: step * PANEL_COUNT,
            height: view?.h,
            transform: `translateX(${trackOffset}px)`,
            transition: dragging ? "none" : "transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          <div style={panelStyle(0)}>
            <div data-fixed-panel style={{ width: PANEL_W }}>
            <canvas ref={canvasRef} width={Math.round(300 * fftScale)} height={Math.round(120 * fftScale)} className="da-fft-canvas" style={{ width: 300, height: 120 }} />
            <div className="da-accent" style={{ marginTop: 6, fontSize: 30, fontWeight: "bold", color: accent, lineHeight: 1 }}>
              {note}
            </div>
            <FftOptionRow
              caption="RESOLUTION"
              value={fftRes}
              options={RES_OPTIONS}
              onChange={setFftRes}
              btnBase={btnBase}
              accent={accent}
              light={light}
            />
            <FftOptionRow
              caption="RESPONSE"
              value={fftPace}
              options={PACE_OPTIONS}
              onChange={setFftPace}
              btnBase={btnBase}
              accent={accent}
              light={light}
            />
            </div>
          </div>

          <div style={panelStyle(1)}>
            <div style={view ? { width: view.w, height: view.h, overflow: "hidden" } : undefined}>
              <div style={view ? {
                width: view.w * songsScale,
                height: view.h * songsScale,
                transform: `scale(${1 / songsScale})`,
                transformOrigin: "0 0",
              } : undefined}>
                <DashboardChordBank size={view ? { w: view.w * songsScale, h: view.h * songsScale } : undefined} />
              </div>
            </div>
          </div>

          <div style={panelStyle(2)}>
            <div data-fixed-panel style={{ width: PANEL_W }}><DashboardMetronome /></div>
          </div>

          <div style={panelStyle(3)}>
            <div data-fixed-panel style={{ width: PANEL_W }}><DashboardTuner /></div>
          </div>
        </div>
      </div>
    </div>
  );
}
