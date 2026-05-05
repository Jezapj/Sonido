import { useEffect, useRef, FC, useState } from 'react';
import { gsap } from 'gsap';
import { GalleryItem } from './CircularGallery';
import './PedalOverlay.css';

// ─── Pedal parameter definitions ──────────────────────────────────────────────
// Each pedal type declares its own knobs. Adding a new pedal = add a new entry.

export interface KnobDef {
  key: string;
  label: string;
  min: number;
  max: number;
  defaultValue: number;
  unit?: string;
  decimals?: number;
}

export interface PedalDef {
  label: string;   // display name
  knobs: KnobDef[];
}

// Maps gallery card text → pedal definition.
// To add a new pedal, add its card text and knob definitions here.
const PEDAL_DEFS: Record<string, PedalDef> = {
  'Blurry Lights': {
    label: 'EQ + Pre-Gain',
    knobs: [
      { key: 'pre_gain',        label: 'Pre-Gain',  min: 0,    max: 4,     defaultValue: 1.0,  unit: '×',  decimals: 2 },
      { key: 'eq_low_gain_db',  label: 'Low Gain',  min: -12,  max: 12,    defaultValue: 0,  unit: 'dB', decimals: 1 },
      { key: 'eq_mid_gain_db',  label: 'Mid Gain',  min: -12,  max: 12,    defaultValue: 0, unit: 'dB', decimals: 1 },
      { key: 'eq_high_gain_db', label: 'High Gain', min: -12,  max: 12,    defaultValue: 0,  unit: 'dB', decimals: 1 },
      { key: 'eq_low_freq',     label: 'Low Freq',  min: 20,   max: 500,   defaultValue: 80,   unit: 'Hz', decimals: 0 },
      { key: 'eq_mid_freq',     label: 'Mid Freq',  min: 200,  max: 5000,  defaultValue: 800,  unit: 'Hz', decimals: 0 },
      { key: 'eq_high_freq',    label: 'High Freq', min: 1000, max: 20000, defaultValue: 6000, unit: 'Hz', decimals: 0 },
      { key: 'eq_low_q',        label: 'Low Q',     min: 0.1,  max: 4,     defaultValue: 1.0,              decimals: 2 },
      { key: 'eq_mid_q',        label: 'Mid Q',     min: 0.1,  max: 4,     defaultValue: 1.0,              decimals: 2 },
      { key: 'eq_high_q',       label: 'High Q',    min: 0.1,  max: 4,     defaultValue: 1.0,              decimals: 2 },
      { key: 'limiter_threshold', label: 'Limiter', min: 0.1,  max: 2,     defaultValue: 0.95,              decimals: 2 },
    ],
  },

  // Generic 3-knob pedals — Adjust1 / Adjust2 / Level
  // These will be replaced with proper definitions once the C DSP files are written.
  'New York': {
    label: 'Overdrive',
    knobs: [
      { key: 'drive', label: 'Drive', min: 0, max: 1, defaultValue: 0.5, decimals: 2 },
      { key: 'tone',  label: 'Tone',  min: 0, max: 1, defaultValue: 0.5, decimals: 2 },
      { key: 'level', label: 'Level', min: 0, max: 1, defaultValue: 0.8, decimals: 2 },
    ],
  },
  'Bridge': {
    label: 'Spring Reverb',
    knobs: [
      { key: 'tone',  label: 'Tone',  min: 0, max: 1, defaultValue: 0.5, decimals: 2 },
      { key: 'time',  label: 'Time',  min: 0, max: 1, defaultValue: 0.4, decimals: 2 },
      { key: 'level', label: 'Level', min: 0, max: 1, defaultValue: 0.6, decimals: 2 },
    ],
  },
};

// Fallback for any card not yet assigned a proper pedal definition
const GENERIC_DEF: PedalDef = {
  label: 'Effect',
  knobs: [
    { key: 'adjust1', label: 'Adjust 1', min: 0, max: 1, defaultValue: 0.5, decimals: 2 },
    { key: 'adjust2', label: 'Adjust 2', min: 0, max: 1, defaultValue: 0.5, decimals: 2 },
    { key: 'level',   label: 'Level',    min: 0, max: 1, defaultValue: 0.5, decimals: 2 },
  ],
};

// ─── State that persists per pedal card ───────────────────────────────────────

export interface PedalState {
  enabled: boolean;
  values: Record<string, number>;  // keyed by KnobDef.key
}

function buildDefaultState(def: PedalDef): PedalState {
  return {
    enabled: false,
    values: Object.fromEntries(def.knobs.map(k => [k.key, k.defaultValue])),
  };
}

// ─── SVG Rotary Knob ──────────────────────────────────────────────────────────

interface KnobProps {
  def: KnobDef;
  value: number;
  onChange: (v: number) => void;
  size?: number;
  disabled?: boolean;
}

const Knob: FC<KnobProps> = ({ def, value, onChange, size = 60, disabled = false }) => {
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);

  const START_DEG = -135;
  const END_DEG   =  135;
  const norm      = Math.max(0, Math.min(1, (value - def.min) / (def.max - def.min)));
  const fillDeg   = START_DEG + norm * (END_DEG - START_DEG);
  const cx = size / 2;
  const cy = size / 2;
  const trackR = size * 0.33;

  const polarXY = (deg: number, r: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };

  const arcPath = (from: number, to: number, r: number) => {
    if (Math.abs(to - from) < 0.3) return '';
    const s = polarXY(from, r);
    const e = polarXY(to,   r);
    const large = to - from > 180 ? 1 : 0;
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  };

  const indicator = polarXY(fillDeg, trackR * 0.68);

  const onMouseDown = (e: React.MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startValue: value };
    const onMove = (me: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = (dragRef.current.startY - me.clientY) / 160;
      onChange(Math.min(def.max, Math.max(def.min, dragRef.current.startValue + delta * (def.max - def.min))));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  };

  const display = value >= 1000
    ? `${(value / 1000).toFixed(1)}k`
    : value.toFixed(def.decimals ?? 1);

  return (
    <div className={`po-knob${disabled ? ' po-knob--disabled' : ''}`}>
      <svg
        width={size} height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="po-knob__svg"
        onMouseDown={onMouseDown}
        onDoubleClick={() => !disabled && onChange(def.defaultValue)}
        style={{ cursor: disabled ? 'default' : 'ns-resize' }}
      >
        <circle cx={cx} cy={cy} r={size * 0.42} fill="#0c0c0c" stroke="#1a1a1a" strokeWidth="1.2" />
        <path d={arcPath(START_DEG, END_DEG, trackR)} fill="none" stroke="#1c1c1c" strokeWidth="3" strokeLinecap="round" />
        {norm > 0.01 && !disabled && (
          <path d={arcPath(START_DEG, fillDeg, trackR)} fill="none" stroke="rgba(180,140,255,0.9)" strokeWidth="3" strokeLinecap="round" />
        )}
        <circle cx={cx} cy={cy} r={size * 0.2} fill="#111" stroke="#252525" strokeWidth="1" />
        <circle
          cx={indicator.x} cy={indicator.y} r={size * 0.062}
          fill={disabled ? 'rgba(255,255,255,0.12)' : 'rgba(200,160,255,1)'}
        />
      </svg>
      <span className="po-knob__label">{def.label}</span>
      <span className="po-knob__value">{disabled ? '—' : `${display}${def.unit ?? ''}`}</span>
    </div>
  );
};

// ─── PedalOverlay ─────────────────────────────────────────────────────────────

interface PedalOverlayProps {
  item: GalleryItem;
  state?: PedalState;
  onStateChange: (s: PedalState) => void;
  onClose: () => void;
}

const PedalOverlay: FC<PedalOverlayProps> = ({ item, state, onStateChange, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef   = useRef<HTMLDivElement>(null);

  const def = PEDAL_DEFS[item.text] ?? GENERIC_DEF;

  // Initialise from persisted state or build from defaults
  const [localState, setLocalState] = useState<PedalState>(
    () => state ?? buildDefaultState(def)
  );

  // Animate in
  useEffect(() => {
    gsap.fromTo(overlayRef.current,
      { opacity: 0 },
      { opacity: 1, duration: 0.22, ease: 'power2.out' }
    );
    gsap.fromTo(panelRef.current,
      { scale: 0.88, y: 36, opacity: 0 },
      { scale: 1,    y: 0,  opacity: 1, duration: 0.36, ease: 'power3.out' }
    );
  }, []);

  const handleClose = () => {
    onStateChange(localState);   // persist on close
    gsap.to(panelRef.current,   { scale: 0.88, y: 36, opacity: 0, duration: 0.2,  ease: 'power2.in' });
    gsap.to(overlayRef.current, { opacity: 0,          duration: 0.24, ease: 'power2.in', onComplete: onClose });
  };

  const setKnob = (key: string, v: number) => {
    setLocalState(prev => ({ ...prev, values: { ...prev.values, [key]: v } }));
  };

  const toggleEnabled = () => {
    setLocalState(prev => ({ ...prev, enabled: !prev.enabled }));
  };

  const { enabled, values } = localState;

  return (
    <div
      ref={overlayRef}
      className="po-overlay"
      onMouseDown={e => { if (e.target === overlayRef.current) handleClose(); }}
    >
      <div ref={panelRef} className="po-panel">

        {/* ── Header ── */}
        <div className="po-header">
          <div className="po-header__img" style={{ backgroundImage: `url(${item.image})` }} />
          <div className="po-header__text">
            <span className="po-header__tag">{def.label}</span>
            <h2 className="po-header__title">{item.text}</h2>
          </div>

          {/* On / Off toggle */}
          <button
            className={`po-toggle${enabled ? ' po-toggle--on' : ' po-toggle--off'}`}
            onClick={toggleEnabled}
            title={enabled ? 'Turn off' : 'Turn on'}
          >
            <span className="po-toggle__dot" />
            <span className="po-toggle__label">{enabled ? 'ON' : 'OFF'}</span>
          </button>

          <button className="po-close" onClick={handleClose}>✕</button>
        </div>

        {/* ── Knobs grid ── */}
        <div className={`po-body${!enabled ? ' po-body--disabled' : ''}`}>
          <div className="po-knobs-grid">
            {def.knobs.map(knob => (
              <Knob
                key={knob.key}
                def={knob}
                value={values[knob.key] ?? knob.defaultValue}
                onChange={v => setKnob(knob.key, v)}
                disabled={!enabled}
              />
            ))}
          </div>
        </div>

        <div className="po-hint">Drag up / down to adjust · Double-click to reset</div>
      </div>
    </div>
  );
};

export default PedalOverlay;