import React, { useRef, useState } from 'react';
import type { PedalState } from './PedalOverlay';
import { useIsLightMode } from './useTheme';

export interface PresetsCardProps {
  pedalStates: Record<string, PedalState>;
  onLoad: (states: Record<string, PedalState>) => void;
}

interface PresetFile {
  version: number;
  savedAt: string;
  appName: string;
  pedals: Record<string, PedalState>;
}

const PresetsCard: React.FC<PresetsCardProps> = ({ pedalStates, onLoad }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null);
  const light = useIsLightMode();

  const activeCount = Object.values(pedalStates).filter(s => s.enabled).length;
  const totalCount  = Object.keys(pedalStates).length;

  const flash = (msg: string, ok: boolean) => {
    setStatus({ msg, ok });
    setTimeout(() => setStatus(null), 2500);
  };

  const handleSave = () => {
    if (totalCount === 0) { flash('No pedals configured yet', false); return; }
    try {
      const payload: PresetFile = {
        version: 1,
        savedAt: new Date().toISOString(),
        appName: 'StanzaUI',
        pedals: pedalStates,
      };
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `stanza-preset-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      flash('Preset saved ✓', true);
    } catch {
      flash('Save failed', false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const raw = JSON.parse(ev.target?.result as string);
        const states: Record<string, PedalState> = raw.pedals ?? raw;
        if (typeof states !== 'object' || states === null) throw new Error();
        onLoad(states);
        const n = Object.keys(states).length;
        flash(`Loaded ${n} pedal${n !== 1 ? 's' : ''} ✓`, true);
      } catch {
        flash('Invalid preset file', false);
      }
    };
    reader.onerror = () => flash('Could not read file', false);
    reader.readAsText(file);
    e.target.value = '';
  };

  const c = {
    summaryText:       light ? 'rgba(0,0,0,0.4)'      : 'rgba(255,255,255,0.28)',
    emptyText:         light ? 'rgba(0,0,0,0.35)'     : 'rgba(255,255,255,0.2)',
    pillActiveBg:      light ? 'rgba(34,197,94,0.12)' : 'rgba(34,197,94,0.12)',
    pillActiveBorder:  light ? 'rgba(34,197,94,0.4)'  : 'rgba(34,197,94,0.3)',
    pillActiveText:    light ? '#166534'              : '#22c55e',
    pillInactiveBg:    light ? 'rgba(0,0,0,0.05)'     : 'rgba(255,255,255,0.05)',
    pillInactiveBorder:light ? 'rgba(0,0,0,0.1)'      : 'rgba(255,255,255,0.08)',
    pillInactiveText:  light ? 'rgba(0,0,0,0.35)'     : 'rgba(255,255,255,0.25)',
    statusOk:          light ? '#166534'              : '#22c55e',
    statusErr:         light ? '#dc2626'              : '#ef4444',
    saveBg:            light ? 'rgba(132,0,255,0.10)' : 'rgba(132,0,255,0.18)',
    saveBgHover:       light ? 'rgba(132,0,255,0.22)' : 'rgba(132,0,255,0.32)',
    saveBorder:        light ? 'rgba(132,0,255,0.4)'  : 'rgba(132,0,255,0.45)',
    saveText:          light ? 'rgba(90,0,200,0.9)'   : 'rgba(200,160,255,0.95)',
    loadBg:            light ? 'rgba(0,0,0,0.05)'     : 'rgba(255,255,255,0.05)',
    loadBgHover:       light ? 'rgba(0,0,0,0.1)'      : 'rgba(255,255,255,0.10)',
    loadBorder:        light ? 'rgba(0,0,0,0.15)'     : 'rgba(255,255,255,0.12)',
    loadText:          light ? 'rgba(0,0,0,0.55)'     : 'rgba(255,255,255,0.55)',
    loadTextHover:     light ? 'rgba(0,0,0,0.85)'     : 'rgba(255,255,255,0.8)',
  };

  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      padding: '10px 14px 14px',
      fontFamily: "'Courier New', monospace",
    }}>
      {totalCount > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <p style={{ margin: '0 0 7px', fontSize: 11, color: c.summaryText, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            {activeCount}/{totalCount} active
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {Object.entries(pedalStates).map(([name, state]) => (
              <div key={name} title={name} style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '3px 9px', borderRadius: 99,
                background: state.enabled ? c.pillActiveBg    : c.pillInactiveBg,
                border: `1px solid ${state.enabled ? c.pillActiveBorder : c.pillInactiveBorder}`,
                fontSize: 10, letterSpacing: '0.04em',
                color: state.enabled ? c.pillActiveText : c.pillInactiveText,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0,
                  boxShadow: state.enabled ? '0 0 5px rgba(34,197,94,0.7)' : 'none',
                }} />
                {name}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p style={{ margin: '0 0 14px', fontSize: 11, color: c.emptyText, lineHeight: 1.6, letterSpacing: '0.04em' }}>
          Open a pedal to configure it,<br />then save your setup here.
        </p>
      )}

      {status && (
        <p style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', color: status.ok ? c.statusOk : c.statusErr }}>
          {status.msg}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={handleSave}
          onMouseEnter={e => (e.currentTarget.style.background = c.saveBgHover)}
          onMouseLeave={e => (e.currentTarget.style.background = c.saveBg)}
          style={{
            flex: 1, padding: '8px 0',
            background: c.saveBg, border: `1px solid ${c.saveBorder}`,
            borderRadius: 8, color: c.saveText,
            fontSize: 12, fontWeight: 700, cursor: 'pointer',
            letterSpacing: '0.05em', transition: 'background 0.2s',
            fontFamily: "'Courier New', monospace",
          }}
        >↓ Save</button>

        <button
          onClick={() => fileInputRef.current?.click()}
          onMouseEnter={e => { e.currentTarget.style.background = c.loadBgHover; e.currentTarget.style.color = c.loadTextHover; }}
          onMouseLeave={e => { e.currentTarget.style.background = c.loadBg;      e.currentTarget.style.color = c.loadText; }}
          style={{
            flex: 1, padding: '8px 0',
            background: c.loadBg, border: `1px solid ${c.loadBorder}`,
            borderRadius: 8, color: c.loadText,
            fontSize: 12, fontWeight: 700, cursor: 'pointer',
            letterSpacing: '0.05em', transition: 'background 0.2s, color 0.2s',
            fontFamily: "'Courier New', monospace",
          }}
        >↑ Load</button>

        <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleFileChange} />
      </div>
    </div>
  );
};

export default PresetsCard;