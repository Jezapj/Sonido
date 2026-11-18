/**
 * Building blocks for the touch layout: controls sized for a fingertip on a
 * small screen, used with one hand while the other holds an instrument.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ── Slider ────────────────────────────────────────────────────────────────────

const DOUBLE_TAP_MS = 320;
const TAP_SLOP_PX = 8;

/**
 * Drag anywhere along it: the value follows the finger from where it was, so
 * landing on the track never makes a level jump. Double-tap resets.
 */
export function TouchSlider({
  value, min, max, onChange, onReset, disabled = false, label, tone,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  onReset?: () => void;
  disabled?: boolean;
  label: string;
  /** CSS colour of the filled part; defaults to the accent. */
  tone?: string;
}) {
  const drag = useRef<{ x: number; value: number; width: number; moved: boolean } | null>(null);
  const lastTap = useRef(0);
  const [active, setActive] = useState(false);
  const span = max - min || 1;
  const norm = clamp((value - min) / span, 0, 1);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, value, width: e.currentTarget.getBoundingClientRect().width || 1, moved: false };
    setActive(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 2) return;
    d.moved = d.moved || Math.abs(dx) > TAP_SLOP_PX;
    onChange(clamp(d.value + (dx / d.width) * span, min, max));
  };

  const end = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    drag.current = null;
    setActive(false);
    if (!d || cancelled || d.moved) return;
    const now = e.timeStamp;
    if (onReset && now - lastTap.current < DOUBLE_TAP_MS) { lastTap.current = 0; onReset(); }
    else lastTap.current = now;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const step = span / 50;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); onChange(clamp(value + step, min, max)); }
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); onChange(clamp(value - step, min, max)); }
  };

  return (
    <div
      className={`ts-slider${active ? " is-active" : ""}${disabled ? " is-disabled" : ""}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-disabled={disabled}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={e => end(e, false)}
      onPointerCancel={e => end(e, true)}
      onKeyDown={onKeyDown}
      style={{ "--ts-slider-pos": norm, ...(tone ? { "--ts-slider-tone": tone } : null) } as React.CSSProperties}
    >
      <div className="ts-slider__rail">
        <div className="ts-slider__fill" />
        <div className="ts-slider__thumb" />
      </div>
    </div>
  );
}

// ── Segmented control ─────────────────────────────────────────────────────────

export function Segmented<T extends string>({
  options, value, onChange, label, className = "",
}: {
  options: { id: T; label: React.ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div className={`ts-seg ${className}`} role="tablist" aria-label={label}>
      {options.map(opt => (
        <button
          key={opt.id}
          type="button"
          role="tab"
          aria-selected={opt.id === value}
          className={`ts-seg__item${opt.id === value ? " is-on" : ""}`}
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Two-step button for things that can't be undone ───────────────────────────

const CONFIRM_MS = 2600;

/** First tap arms it and shows `confirmLabel`; a second tap within a moment goes through. */
export function ConfirmButton({
  onConfirm, children, confirmLabel = "Tap again", disabled = false, className = "", title,
}: {
  onConfirm: () => void;
  children: React.ReactNode;
  confirmLabel?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => clearTimeout(id);
  }, [armed]);
  useEffect(() => { if (disabled) setArmed(false); }, [disabled]);

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      className={`${className}${armed ? " is-armed" : ""}`}
      onClick={e => {
        e.stopPropagation();
        if (armed) { setArmed(false); onConfirm(); }
        else setArmed(true);
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}

// ── Scale-to-fit host for the dashboard's fixed-size panels ───────────────────

/**
 * Hands its child the room it has, divided by `scale`, and draws it `scale`
 * times larger: a panel laid out for a mouse comes out finger-sized.
 * `scale` is in multiples of the touch layout's font size (1 = 16px at 800 × 480).
 */
export function ScaleBox({
  scale, children, className = "",
}: {
  scale: number;
  children: (size: { w: number; h: number }) => React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number; k: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const em = parseFloat(getComputedStyle(el).fontSize) || 16;
      const k = scale * (em / 16);
      const w = el.clientWidth / k, h = el.clientHeight / k;
      if (w < 1 || h < 1) return;
      setBox(prev => (prev && Math.abs(prev.w - w) < 0.5 && Math.abs(prev.h - h) < 0.5 && prev.k === k ? prev : { w, h, k }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scale]);

  return (
    <div ref={ref} className={`ts-scalebox ${className}`}>
      {box && (
        <div style={{ width: box.w, height: box.h, transform: `scale(${box.k})`, transformOrigin: "0 0" }}>
          {children({ w: box.w, h: box.h })}
        </div>
      )}
    </div>
  );
}

// ── Icons (24 × 24, drawn with the current colour) ────────────────────────────

const Svg = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="ts-icon">
    {children}
  </svg>
);

export const Icons = {
  tuner: (
    <Svg>
      <path d="M3.5 17a8.5 8.5 0 0 1 17 0" />
      <path d="M12 17l3.5-6.5" />
      <path d="M12 5.5v2M5.2 9.6l1.6 1.2M18.8 9.6l-1.6 1.2" />
      <circle cx="12" cy="17" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  ),
  metro: (
    <Svg>
      <path d="M8.5 3.5h7L19 20.5H5L8.5 3.5z" />
      <path d="M12 16.5l5.5-10" />
      <path d="M6.2 15h11.6" />
    </Svg>
  ),
  songs: (
    <Svg>
      <path d="M9 17.5V5.5l10-2v12" />
      <circle cx="6.5" cy="17.5" r="2.5" />
      <circle cx="16.5" cy="15.5" r="2.5" />
    </Svg>
  ),
  notes: (
    <Svg>
      <path d="M2.5 12h2.2l1.8-5 2.6 11 2.7-14 2.6 12 2-7 1.6 3h3.5" />
    </Svg>
  ),
  pedals: (
    <Svg>
      <rect x="5.5" y="3" width="13" height="18" rx="2.5" />
      <circle cx="9.3" cy="7.3" r="1.3" />
      <circle cx="14.7" cy="7.3" r="1.3" />
      <rect x="8.5" y="13" width="7" height="4.5" rx="1.2" />
    </Svg>
  ),
  looper: (
    <Svg>
      <path d="M17 2.5l3.5 3.5L17 9.5" />
      <path d="M3.5 11V9a3 3 0 0 1 3-3h14" />
      <path d="M7 21.5L3.5 18 7 14.5" />
      <path d="M20.5 13v2a3 3 0 0 1-3 3h-14" />
    </Svg>
  ),
  presets: (
    <Svg>
      <path d="M12 3l9 4.5-9 4.5-9-4.5L12 3z" />
      <path d="M3 12l9 4.5 9-4.5" />
      <path d="M3 16.5L12 21l9-4.5" />
    </Svg>
  ),
  system: (
    <Svg>
      <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="17" r="2" />
    </Svg>
  ),
  back: (
    <Svg>
      <path d="M14.5 5.5L8 12l6.5 6.5" />
    </Svg>
  ),
  refresh: (
    <Svg>
      <path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5" />
      <path d="M4 4v4.5h4.5" />
      <path d="M4 13a8 8 0 0 0 14.3 4.3L20 15.5" />
      <path d="M20 20v-4.5h-4.5" />
    </Svg>
  ),
  edit: (
    <Svg>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </Svg>
  ),
  trash: (
    <Svg>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </Svg>
  ),
  fullscreen: (
    <Svg>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </Svg>
  ),
};
