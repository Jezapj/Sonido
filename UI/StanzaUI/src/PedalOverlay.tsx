import { useEffect, useRef, FC, useState } from 'react';
import { gsap } from 'gsap';
import { GalleryItem } from './CircularGallery';
import './PedalOverlay.css';

// ─── DSP Types ─────────────────────────────────────────────────────────────────
// Mirrors dsp_params_t in Interface/ESP32/I2SESP_V3/dsp_params.h

export interface DspParams {
  pre_gain: number;
  eq_low_gain_db: number;
  eq_mid_gain_db: number;
  eq_high_gain_db: number;
  eq_low_freq: number;
  eq_mid_freq: number;
  eq_high_freq: number;
  eq_low_q: number;
  eq_mid_q: number;
  eq_high_q: number;
  limiter_threshold: number;
}

// ─── Per-card default presets ──────────────────────────────────────────────────

const PRESETS: Record<string, DspParams> = {
  'Blurry Lights': {
    pre_gain: 1.3,
    eq_low_gain_db: 3.0,
    eq_mid_gain_db: -4.0,
    eq_high_gain_db: 5.0,
    eq_low_freq: 80.0,
    eq_mid_freq: 800.0,
    eq_high_freq: 6000.0,
    eq_low_q: 0.6,
    eq_mid_q: 1.2,
    eq_high_q: 0.8,
    limiter_threshold: 0.9,
  },
  'New York': {
    pre_gain: 2.0,
    eq_low_gain_db: 5.0,
    eq_mid_gain_db: 2.0,
    eq_high_gain_db: -1.0,
    eq_low_freq: 120.0,
    eq_mid_freq: 1200.0,
    eq_high_freq: 5000.0,
    eq_low_q: 0.9,
    eq_mid_q: 0.8,
    eq_high_q: 0.7,
    limiter_threshold: 0.85,
  },
};

const FALLBACK_PARAMS: DspParams = {
  pre_gain: 1.0,
  eq_low_gain_db: 0.0,
  eq_mid_gain_db: 0.0,
  eq_high_gain_db: -2.0,
  eq_low_freq: 100.0,
  eq_mid_freq: 1000.0,
  eq_high_freq: 5000.0,
  eq_low_q: 0.7,
  eq_mid_q: 1.0,
  eq_high_q: 0.7,
  limiter_threshold: 1.0,
};

// ─── SVG Rotary Knob ────────────────────────────────────────────────────────────

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  unit?: string;
  decimals?: number;
  size?: number;
  onChange: (v: number) => void;
}

const Knob: FC<KnobProps> = ({
  label, value, min, max, defaultValue,
  unit = '', decimals = 1, size = 64,
  onChange,
}) => {
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);

  const START_DEG = -135;
  const END_DEG   =  135;
  const norm       = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const fillDeg    = START_DEG + norm * (END_DEG - START_DEG);
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
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startValue: value };
    const onMove = (me: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = (dragRef.current.startY - me.clientY) / 160;
      onChange(Math.min(max, Math.max(min, dragRef.current.startValue + delta * (max - min))));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const display = value >= 1000
    ? `${(value / 1000).toFixed(1)}k`
    : value.toFixed(decimals);

  return (
    <div className="po-knob">
      <svg
        width={size} height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="po-knob__svg"
        onMouseDown={onMouseDown}
        onDoubleClick={() => onChange(defaultValue)}
        style={{ cursor: 'ns-resize' }}
      >
        <circle cx={cx} cy={cy} r={size * 0.42} fill="#0c0c0c" stroke="#1a1a1a" strokeWidth="1.2" />
        <path d={arcPath(START_DEG, END_DEG, trackR)} fill="none" stroke="#1c1c1c" strokeWidth="3" strokeLinecap="round" />
        {norm > 0.01 && (
          <path d={arcPath(START_DEG, fillDeg, trackR)} fill="none" stroke="rgba(180,140,255,0.9)" strokeWidth="3" strokeLinecap="round" />
        )}
        <circle cx={cx} cy={cy} r={size * 0.2} fill="#111" stroke="#252525" strokeWidth="1" />
        <circle cx={indicator.x} cy={indicator.y} r={size * 0.062} fill="rgba(200,160,255,1)" />
      </svg>
      <span className="po-knob__label">{label}</span>
      <span className="po-knob__value">{display}{unit}</span>
    </div>
  );
};

// ─── Band column ───────────────────────────────────────────────────────────────

const Band: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="po-band">
    <div className="po-band__label">{label}</div>
    <div className="po-band__knobs">{children}</div>
  </div>
);

// ─── Section ──────────────────────────────────────────────────────────────────

const Section: FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="po-section">
    <div className="po-section__title">{title}</div>
    {children}
  </div>
);

// ─── PedalOverlay ─────────────────────────────────────────────────────────────

interface PedalOverlayProps {
  item: GalleryItem;
  onClose: () => void;
  /** Called on every knob change — hook this up to your Tauri IPC later */
  onDspChange?: (params: DspParams) => void;
}

const PedalOverlay: FC<PedalOverlayProps> = ({ item, onClose, onDspChange }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef   = useRef<HTMLDivElement>(null);

  const [params, setParams] = useState<DspParams>(
    () => PRESETS[item.text] ?? { ...FALLBACK_PARAMS }
  );

  // Animate in
  useEffect(() => {
    gsap.fromTo(overlayRef.current,
      { opacity: 0 },
      { opacity: 1, duration: 0.22, ease: 'power2.out' }
    );
    gsap.fromTo(panelRef.current,
      { scale: 0.88, y: 36, opacity: 0 },
      { scale: 1,    y: 0,  opacity: 1, duration: 0.38, ease: 'power3.out' }
    );
  }, []);

  const handleClose = () => {
    gsap.to(panelRef.current,   { scale: 0.88, y: 36, opacity: 0, duration: 0.22, ease: 'power2.in' });
    gsap.to(overlayRef.current, {
      opacity: 0, duration: 0.26, ease: 'power2.in',
      onComplete: onClose,
    });
  };

  const set = (key: keyof DspParams) => (v: number) => {
    setParams(prev => {
      const next = { ...prev, [key]: v };
      onDspChange?.(next);
      return next;
    });
  };

  return (
    <div ref={overlayRef} className="po-overlay" onClick={handleClose}>
      <div ref={panelRef} className="po-panel" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="po-header">
          <div className="po-header__image" style={{ backgroundImage: `url(${item.image})` }} />
          <div className="po-header__text">
            <span className="po-header__tag">Effect Pedal</span>
            <h2 className="po-header__title">{item.text}</h2>
          </div>
          <button className="po-close" onClick={handleClose}>✕</button>
        </div>

        {/* Controls */}
        <div className="po-body">

          <Section title="Signal">
            <div className="po-row">
              <Knob label="Pre-Gain"  value={params.pre_gain}           min={0}   max={4}   defaultValue={1}   unit="×"  decimals={2} onChange={set('pre_gain')} size={72} />
              <Knob label="Limiter"   value={params.limiter_threshold}  min={0.1} max={2}   defaultValue={1}             decimals={2} onChange={set('limiter_threshold')} size={72} />
            </div>
          </Section>

          <Section title="EQ — Gain">
            <div className="po-row">
              <Band label="Low">
                <Knob label="Gain" value={params.eq_low_gain_db}  min={-12} max={12} defaultValue={0}  unit="dB" onChange={set('eq_low_gain_db')} />
              </Band>
              <Band label="Mid">
                <Knob label="Gain" value={params.eq_mid_gain_db}  min={-12} max={12} defaultValue={0}  unit="dB" onChange={set('eq_mid_gain_db')} />
              </Band>
              <Band label="High">
                <Knob label="Gain" value={params.eq_high_gain_db} min={-12} max={12} defaultValue={-2} unit="dB" onChange={set('eq_high_gain_db')} />
              </Band>
            </div>
          </Section>

          <Section title="EQ — Frequency & Resonance">
            <div className="po-row">
              <Band label="Low">
                <Knob label="Freq" value={params.eq_low_freq} min={20}   max={500}   defaultValue={100}  unit="Hz" decimals={0} onChange={set('eq_low_freq')} />
                <Knob label="Q"    value={params.eq_low_q}    min={0.1}  max={4}     defaultValue={0.7}            decimals={2} onChange={set('eq_low_q')} />
              </Band>
              <Band label="Mid">
                <Knob label="Freq" value={params.eq_mid_freq} min={200}  max={5000}  defaultValue={1000} unit="Hz" decimals={0} onChange={set('eq_mid_freq')} />
                <Knob label="Q"    value={params.eq_mid_q}    min={0.1}  max={4}     defaultValue={1.0}            decimals={2} onChange={set('eq_mid_q')} />
              </Band>
              <Band label="High">
                <Knob label="Freq" value={params.eq_high_freq} min={1000} max={20000} defaultValue={5000} unit="Hz" decimals={0} onChange={set('eq_high_freq')} />
                <Knob label="Q"    value={params.eq_high_q}    min={0.1}  max={4}     defaultValue={0.7}            decimals={2} onChange={set('eq_high_q')} />
              </Band>
            </div>
          </Section>

        </div>

        <div className="po-hint">Drag up / down to adjust · Double-click to reset</div>
      </div>
    </div>
  );
};

export default PedalOverlay;