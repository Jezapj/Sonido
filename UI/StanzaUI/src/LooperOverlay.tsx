import { useEffect, useRef, useState, useCallback, FC } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { gsap } from 'gsap';
import type { GalleryItem } from './CircularGallery';
import { useIsLightMode } from './UseTheme';
import './PedalOverlay.css'; // reuse panel / overlay base styles

// ── Types ─────────────────────────────────────────────────────────────────────

type LooperStateStr = 'Idle' | 'Recording' | 'Playing' | 'Overdubbing' | 'Stopped';

interface LooperInfo {
  state:         LooperStateStr;
  loop_len_secs: number;
  play_pos_secs: number;
  progress:      number;   // 0.0 – 1.0
  mix:           number;
  feedback:      number;
  monitor_live:  boolean;
}

interface LooperOverlayProps {
  item:    GalleryItem;
  onClose: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const RING_R    = 54;                          // SVG progress ring radius
const RING_CIRC = 2 * Math.PI * RING_R;       // full circumference

// Human-readable labels and colours for each state
const STATE_META: Record<LooperStateStr, { label: string; color: string; pulse: boolean }> = {
  Idle:        { label: 'IDLE',       color: 'rgba(255,255,255,0.3)',  pulse: false },
  Recording:   { label: 'REC',        color: '#ef4444',               pulse: true  },
  Playing:     { label: 'PLAYING',    color: '#22c55e',               pulse: false },
  Overdubbing: { label: 'OVERDUB',    color: '#f59e0b',               pulse: true  },
  Stopped:     { label: 'STOPPED',    color: 'rgba(255,255,255,0.3)', pulse: false },
};

// What the TAP button says in each state
const TAP_LABEL: Record<LooperStateStr, string> = {
  Idle:        '● REC',
  Recording:   '■ STOP',
  Playing:     '◉ OVERDUB',
  Overdubbing: '◉ PLAYING',
  Stopped:     '● REC',
};

// ── Small slider used for mix / feedback ──────────────────────────────────────

const MiniSlider: FC<{
  label: string; value: number; min: number; max: number;
  step?: number; unit?: string; onChange: (v: number) => void; light: boolean;
}> = ({ label, value, min, max, step = 0.01, unit = '', onChange, light }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10,
      color: light ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.35)', letterSpacing: '0.06em' }}>
      <span>{label}</span>
      <span style={{ fontFamily: 'Courier New', color: light ? 'rgba(90,0,200,0.8)' : 'rgba(180,140,255,0.85)' }}>
        {value.toFixed(2)}{unit}
      </span>
    </div>
    <input
      type="range" min={min} max={max} step={step} value={value}
      onChange={e => onChange(Number(e.target.value))}
      style={{
        WebkitAppearance: 'none', appearance: 'none',
        width: '90%', height: 3, borderRadius: 99, outline: 'none', cursor: 'pointer',
        background: `linear-gradient(to right, rgba(132,0,255,0.8) ${((value - min) / (max - min)) * 100}%, rgba(255,255,255,0.12) 0%)`,
      }}
    />
  </div>
);

// ── Main component ────────────────────────────────────────────────────────────

const LooperOverlay: FC<LooperOverlayProps> = ({ item, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef   = useRef<HTMLDivElement>(null);
  const light      = useIsLightMode();

  const [info, setInfo] = useState<LooperInfo>({
    state: 'Idle', loop_len_secs: 0, play_pos_secs: 0, progress: 0,
    mix: 1.0, feedback: 0.9, monitor_live: false,
  });
  const [mix,         setMixLocal]         = useState(1.0);
  const [feedback,    setFeedbackLocal]    = useState(0.9);
  const [monitorLive, setMonitorLiveLocal] = useState(false);
  const [busy,        setBusy]             = useState(false);

  const meta = STATE_META[info.state] ?? STATE_META.Idle;

  // ── Animate in ───────────────────────────────────────────────────────────
  useEffect(() => {
    gsap.fromTo(overlayRef.current, { opacity: 0 }, { opacity: 1, duration: 0.22, ease: 'power2.out' });
    gsap.fromTo(panelRef.current,
      { scale: 0.88, y: 36, opacity: 0 },
      { scale: 1,    y: 0,  opacity: 1, duration: 0.36, ease: 'power3.out' });

    // Fetch current state on mount
    invoke<LooperInfo>('get_looper_info').then(i => {
      setInfo(i);
      setMixLocal(i.mix);
      setFeedbackLocal(i.feedback);
      setMonitorLiveLocal(!!i.monitor_live);
    }).catch(() => {});

    // Subscribe to throttled looper_info events (~10 Hz)
    let unlisten: UnlistenFn | null = null;
    listen<LooperInfo>('looper_info', e => {
      setInfo(e.payload);
      if (typeof e.payload.monitor_live === 'boolean') {
        setMonitorLiveLocal(e.payload.monitor_live);
      }
    }).then(u => { unlisten = u; });

    return () => { unlisten?.(); };
  }, []);

  // ── Animate out and close ────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    gsap.to(panelRef.current,   { scale: 0.88, y: 36, opacity: 0, duration: 0.2, ease: 'power2.in' });
    gsap.to(overlayRef.current, { opacity: 0, duration: 0.24, ease: 'power2.in', onComplete: onClose });
  }, [onClose]);

  // ── Command helpers ───────────────────────────────────────────────────────
  const tap = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try { const i = await invoke<LooperInfo>('looper_tap'); setInfo(i); }
    catch { /* ignore */ } finally { setBusy(false); }
  }, [busy]);

  const stop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try { const i = await invoke<LooperInfo>('looper_stop'); setInfo(i); }
    catch { /* ignore */ } finally { setBusy(false); }
  }, [busy]);

  const play = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try { const i = await invoke<LooperInfo>('looper_play'); setInfo(i); }
    catch { /* ignore */ } finally { setBusy(false); }
  }, [busy]);

  const clear = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try { const i = await invoke<LooperInfo>('looper_clear'); setInfo(i); }
    catch { /* ignore */ } finally { setBusy(false); }
  }, [busy]);

  const updateParams = useCallback(async (newMix: number, newFeedback: number) => {
    try { await invoke('set_looper_params', { mix: newMix, feedback: newFeedback }); }
    catch { /* ignore */ }
  }, []);

  const onMixChange = useCallback((v: number) => {
    setMixLocal(v);
    updateParams(v, feedback);
  }, [feedback, updateParams]);

  const onFeedbackChange = useCallback((v: number) => {
    setFeedbackLocal(v);
    updateParams(mix, v);
  }, [mix, updateParams]);

  const toggleMonitorLive = useCallback(async () => {
    const next = !monitorLive;
    setMonitorLiveLocal(next);
    try {
      const i = await invoke<LooperInfo>('set_looper_monitor_live', { monitorLive: next });
      setInfo(i);
      setMonitorLiveLocal(!!i.monitor_live);
    } catch { /* ignore */ }
  }, [monitorLive]);

  // ── Derived display values ────────────────────────────────────────────────
  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1).padStart(4, '0');
    return `${m}:${sec}`;
  };

  const ringOffset = RING_CIRC * (1 - info.progress);

  const tapColor =
    info.state === 'Recording'   ? '#ef4444' :
    info.state === 'Overdubbing' ? '#f59e0b' :
    info.state === 'Playing'     ? '#a855f7' :
    'rgba(255,255,255,0.75)';

  const stopDisabled  = info.state === 'Idle';
  const clearDisabled = info.state === 'Idle';
  const isStopped     = info.state === 'Stopped';
  const loopingActive = info.state === 'Playing' || info.state === 'Overdubbing';

  // ── Colour tokens ─────────────────────────────────────────────────────────
  const c = {
    panel:       light ? '#f5f2fa'                    : '#0d0b12',
    border:      light ? 'rgba(132,0,255,0.15)'       : 'rgba(255,255,255,0.08)',
    header:      light ? '#ede8f6'                    : '#100e18',
    headerBorder:light ? 'rgba(132,0,255,0.10)'       : 'rgba(255,255,255,0.06)',
    titleText:   light ? '#1a0f2e'                    : 'rgba(255,255,255,0.92)',
    tagText:     light ? 'rgba(100,0,200,0.55)'       : 'rgba(180,140,255,0.5)',
    ringTrack:   light ? 'rgba(0,0,0,0.08)'           : 'rgba(255,255,255,0.08)',
    ringFill:    meta.color,
    timeText:    light ? '#1a0f2e'                    : '#fff',
    dimText:     light ? 'rgba(0,0,0,0.35)'           : 'rgba(255,255,255,0.28)',
    btnBg:       light ? 'rgba(0,0,0,0.05)'           : 'rgba(255,255,255,0.05)',
    btnBorder:   light ? 'rgba(0,0,0,0.12)'           : 'rgba(255,255,255,0.1)',
    btnText:     light ? 'rgba(0,0,0,0.6)'            : 'rgba(255,255,255,0.6)',
    closeBg:     light ? 'rgba(0,0,0,0.05)'           : 'rgba(255,255,255,0.05)',
    closeBorder: light ? 'rgba(0,0,0,0.12)'           : 'rgba(255,255,255,0.1)',
    closeText:   light ? 'rgba(0,0,0,0.35)'           : 'rgba(255,255,255,0.35)',
    hint:        light ? 'rgba(0,0,0,0.18)'           : 'rgba(255,255,255,0.14)',
  };

  // ── Button helper ─────────────────────────────────────────────────────────
  const Btn: FC<{
    onClick: () => void; disabled?: boolean; color?: string;
    border?: string; children: React.ReactNode; pulse?: boolean;
  }> = ({ onClick, disabled, color, border, children, pulse }) => (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      style={{
        background:   color   ?? c.btnBg,
        border:      `1px solid ${border ?? c.btnBorder}`,
        color:        color   ? '#fff' : c.btnText,
        borderRadius: 10, padding: '10px 0', fontSize: 12,
        fontWeight: 700, letterSpacing: '0.06em', cursor: 'pointer',
        flex: 1, fontFamily: "'Courier New', monospace",
        opacity: (disabled || busy) ? 0.35 : 1,
        transition: 'background 0.15s, opacity 0.15s',
        animation: pulse ? 'po-pulse 1.1s ease-in-out infinite' : 'none',
      }}
    >{children}</button>
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @keyframes po-pulse {
          0%,100% { box-shadow: 0 0 0 0 ${meta.color}44; }
          50%      { box-shadow: 0 0 0 8px ${meta.color}00; }
        }
      `}</style>

      <div
        ref={overlayRef}
        className="po-overlay"
        onMouseDown={e => { if (e.target === overlayRef.current) handleClose(); }}
      >
        <div
          ref={panelRef}
          className="po-panel"
          style={{ background: c.panel, border: `1px solid ${c.border}`, height: '34vh', minHeight: '4vh', overflowY: 'visible', scrollbarWidth: 'none' }}
        >

          {/* ── Header ────────────────────────────────────────────────────── */}
          <div className="po-header" style={{ background: c.header, borderBottomColor: c.headerBorder }}>
            <div
              className="po-header__img"
              style={{ backgroundImage: `url(${item.image})`, borderColor: c.border }}
            />
            <div className="po-header__text">
              <span className="po-header__tag" style={{ color: c.tagText }}>Looper</span>
              <h2 className="po-header__title" style={{ color: c.titleText }}>{item.text}</h2>
            </div>

            {/* State badge */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 12px 5px 8px', borderRadius: 999,
              background: `${meta.color}18`, border: `1px solid ${meta.color}55`,
              fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
              color: meta.color, flexShrink: 0,
              animation: meta.pulse ? 'po-pulse 1.1s ease-in-out infinite' : 'none',
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%',
                background: meta.color, boxShadow: `0 0 6px ${meta.color}`, flexShrink: 0 }} />
              {meta.label}
            </div>

            <button
              className="po-close"
              onClick={handleClose}
              style={{ background: c.closeBg, borderColor: c.closeBorder, color: c.closeText }}
            >✕</button>
          </div>

          {/* ── Body ──────────────────────────────────────────────────────── */}
          <div className="po-body" style={{ paddingBottom: '0.5rem' }}>

            {/* Progress ring + time display */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '2rem', marginBottom: '1.25rem' }}>

              <div style={{ position: 'relative', flexShrink: 0 }}>
                <svg width={130} height={130} viewBox="0 0 130 130">
                  {/* Track */}
                  <circle cx={65} cy={65} r={RING_R}
                    fill="none" stroke={c.ringTrack} strokeWidth={6} />
                  {/* Fill */}
                  <circle cx={65} cy={65} r={RING_R}
                    fill="none" stroke={meta.color} strokeWidth={6}
                    strokeLinecap="round"
                    strokeDasharray={RING_CIRC}
                    strokeDashoffset={ringOffset}
                    transform="rotate(-90 65 65)"
                    style={{ transition: 'stroke-dashoffset 0.1s linear, stroke 0.3s' }}
                  />
                </svg>
                {/* Centre time */}
                <div style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                }}>
                  <span style={{ fontFamily: 'Courier New', fontSize: 18, fontWeight: 800,
                    color: c.timeText, letterSpacing: '-0.02em' }}>
                    {info.state === 'Recording'
                      ? fmtTime(info.loop_len_secs)
                      : fmtTime(info.play_pos_secs)}
                  </span>
                  <span style={{ fontFamily: 'Courier New', fontSize: 10,
                    color: c.dimText, letterSpacing: '0.04em', marginTop: 2 }}>
                    {info.loop_len_secs > 0 ? `/ ${fmtTime(info.loop_len_secs)}` : '—'}
                  </span>
                </div>
              </div>

              {/* Controls column */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>

                {/* TAP — main action */}
                <button
                  onClick={tap}
                  disabled={busy}
                  style={{
                    background:  `${tapColor}22`,
                    border:      `1px solid ${tapColor}88`,
                    color:        tapColor,
                    borderRadius: 10, padding: '14px 0', fontSize: 15,
                    fontWeight: 800, letterSpacing: '0.08em', cursor: 'pointer',
                    fontFamily: "'Courier New', monospace",
                    opacity: busy ? 0.5 : 1,
                    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                    animation: meta.pulse ? 'po-pulse 1.1s ease-in-out infinite' : 'none',
                  }}
                >{TAP_LABEL[info.state]}</button>

                {/* STOP / PLAY + CLEAR */}
                <div style={{ display: 'flex', gap: 8 }}>
                  {isStopped ? (
                    <Btn
                      onClick={play}
                      color="rgba(34,197,94,0.65)"
                      border="rgba(34,197,94,0.55)"
                    >▶ PLAY</Btn>
                  ) : (
                    <Btn
                      onClick={stop} disabled={stopDisabled}
                      color={stopDisabled ? undefined : 'rgba(239,68,68,0.6)'}
                      border={stopDisabled ? undefined : 'rgba(239,68,68,0.5)'}
                    >⏹ STOP</Btn>
                  )}
                  <Btn
                    onClick={clear} disabled={clearDisabled}
                    color={clearDisabled ? undefined : 'rgba(100,100,100,0.5)'}
                    border={clearDisabled ? undefined : 'rgba(255,255,255,0.2)'}
                  >✕ CLEAR</Btn>
                </div>
              </div>
            </div>

            {/* Loop volume + Overdub decay */}
            <div style={{ display: 'flex', gap: '1.5rem', padding: '0.75rem 0 0.25rem' }}>
              <MiniSlider
                label="Loop Volume" value={mix} min={0} max={4} step={0.01}
                onChange={onMixChange} light={light}
              />
              <MiniSlider
                label="Overdub Decay" value={feedback} min={0.5} max={1.0} step={0.01}
                onChange={onFeedbackChange} light={light}
              />
            </div>

            {/* Monitor live input while looping */}
            <div style={{ padding: '0.65rem 0 0.15rem' }}>
              <button
                type="button"
                onClick={toggleMonitorLive}
                disabled={busy}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '10px 12px',
                  borderRadius: 10,
                  cursor: 'pointer',
                  fontFamily: "'Courier New', monospace",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  transition: 'background 0.15s, border-color 0.15s, opacity 0.15s',
                  background: monitorLive
                    ? (light ? 'rgba(34,197,94,0.12)' : 'rgba(34,197,94,0.18)')
                    : (light ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.04)'),
                  border: `1px solid ${monitorLive
                    ? 'rgba(34,197,94,0.45)'
                    : (light ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)')}`,
                  color: monitorLive
                    ? (light ? 'rgba(22,101,52,0.95)' : 'rgba(134,239,172,0.95)')
                    : (light ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.45)'),
                  opacity: busy ? 0.5 : 1,
                }}
              >
                <span>MONITOR LIVE INPUT</span>
                <span style={{ fontWeight: 800 }}>
                  {monitorLive ? 'ON' : 'OFF'}
                  {loopingActive && !monitorLive ? ' · LOOP ONLY' : ''}
                </span>
              </button>
            </div>

          </div>

          {/* ── Hint ──────────────────────────────────────────────────────── */}
          <div className="po-hint" style={{ color: c.hint }}>
            Space rec/stop/play · Shift clear · TAP overdubs while playing
          </div>
        </div>
      </div>
    </>
  );
};

export default LooperOverlay;
