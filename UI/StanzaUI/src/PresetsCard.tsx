import React, { useRef, useState, useCallback, useEffect } from 'react';
import type { PedalState } from './PedalOverlay';
import { useIsLightMode } from './UseTheme';

export interface PresetsCardProps {
  pedalStates:    Record<string, PedalState>;
  onLoad:         (states: Record<string, PedalState>) => void;
  onPresetSaved?: () => void;
}

interface PresetEntry {
  id:     string;
  name:   string;
  pedals: Record<string, PedalState>;
}

interface PresetFile {
  version: number;
  savedAt: string;
  appName: string;
  pedals:  Record<string, PedalState>;
}

const BANK_KEY      = 'stanza-preset-bank';
const MAX_BANK_SIZE = 12;

function readBank(): PresetEntry[] {
  try {
    const raw = localStorage.getItem(BANK_KEY);
    return raw ? (JSON.parse(raw) as PresetEntry[]) : [];
  } catch { return []; }
}

function writeBank(entries: PresetEntry[]): void {
  try { localStorage.setItem(BANK_KEY, JSON.stringify(entries)); } catch {}
}

function autoName(): string {
  const d = new Date();
  const day  = d.getDate();
  const mon  = d.toLocaleString('en-AU', { month: 'short' });
  const hh   = String(d.getHours()).padStart(2, '0');
  const mm   = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${mon} ${hh}:${mm}`;
}

function cleanFilename(raw: string): string {
  const stem = raw.replace(/\.json$/i, '');
  const m = stem.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]} ${m[4]}:${m[5]}`;
  return stem.replace(/^stanza-preset-/, '') || stem;
}

const PresetsCard: React.FC<PresetsCardProps> = ({ pedalStates, onLoad, onPresetSaved }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const light        = useIsLightMode();

  const [bank,         setBank]         = useState<PresetEntry[]>(readBank);
  const [activeId,     setActiveId]     = useState<string | null>(null);
  const [editingId,    setEditingId]    = useState<string | null>(null);
  const [editDraft,    setEditDraft]    = useState('');
  const [status,       setStatus]       = useState<{ msg: string; ok: boolean } | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  // Clamp focusedIndex when bank shrinks
  useEffect(() => {
    if (focusedIndex !== null && focusedIndex >= bank.length) {
      setFocusedIndex(bank.length > 0 ? bank.length - 1 : null);
    }
  }, [bank.length]);

  const flash = useCallback((msg: string, ok: boolean) => {
    setStatus({ msg, ok });
    const t = setTimeout(() => setStatus(null), 2400);
    return () => clearTimeout(t);
  }, []);

  const commitBank = useCallback((next: PresetEntry[], newActive?: string | null) => {
    setBank(next);
    writeBank(next);
    if (newActive !== undefined) setActiveId(newActive);
  }, []);

  const handleApply = useCallback((entry: PresetEntry) => {
    if (editingId) return;
    setActiveId(entry.id);
    onLoad(entry.pedals);
    flash(`→ "${entry.name}"`, true);
  }, [editingId, onLoad, flash]);

  // ── Keyboard navigation ───────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept while typing in any input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (editingId) return;
      if (bank.length === 0) return;

      switch (e.key) {
        case 'w':
        case 'W':
        case 'ArrowUp':
          e.preventDefault();
          setFocusedIndex(prev =>
            prev === null ? bank.length - 1 : (prev - 1 + bank.length) % bank.length
          );
          break;

        case 's':
        case 'S':
        case 'ArrowDown':
          e.preventDefault();
          setFocusedIndex(prev =>
            prev === null ? 0 : (prev + 1) % bank.length
          );
          break;

        case 'Enter':
          e.preventDefault();
          if (focusedIndex !== null && bank[focusedIndex]) {
            handleApply(bank[focusedIndex]);
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [bank, focusedIndex, editingId, handleApply]);

  const handleRemove = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = bank.filter(b => b.id !== id);
    commitBank(next, activeId === id ? null : activeId);
  }, [bank, activeId, commitBank]);

  const handleSnapshot = useCallback(() => {
    if (Object.keys(pedalStates).length === 0) {
      flash('No pedals configured yet', false);
      return;
    }
    const entry: PresetEntry = {
      id:     String(Date.now()),
      name:   autoName(),
      pedals: { ...pedalStates },
    };
    const next = [...bank, entry].slice(-MAX_BANK_SIZE);
    commitBank(next, entry.id);
    setFocusedIndex(next.length - 1);
    flash(`Saved "${entry.name}" to bank`, true);
  }, [pedalStates, bank, commitBank, flash]);

  const handleSave = useCallback(() => {
    if (Object.keys(pedalStates).length === 0) {
      flash('No pedals configured yet', false);
      return;
    }
    try {
      const now  = new Date();
      const name = autoName();
      const payload: PresetFile = {
        version: 1,
        savedAt: now.toISOString(),
        appName: 'StanzaUI',
        pedals:  pedalStates,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `stanza-preset-${now.toISOString().slice(0, 19).replace(/[T:]/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const entry: PresetEntry = { id: String(Date.now()), name, pedals: { ...pedalStates } };
      const next = [...bank, entry].slice(-MAX_BANK_SIZE);
      commitBank(next, entry.id);
      setFocusedIndex(next.length - 1);
      flash(`Saved "${name}" ✓`, true);
      onPresetSaved?.();
    } catch { flash('Save failed', false); }
  }, [pedalStates, bank, commitBank, flash, onPresetSaved]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = cleanFilename(file.name);
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const raw    = JSON.parse(ev.target?.result as string);
        const states: Record<string, PedalState> = raw.pedals ?? raw;
        if (typeof states !== 'object' || states === null) throw new Error();
        const entry: PresetEntry = { id: String(Date.now()), name, pedals: states };
        const next = [...bank, entry].slice(-MAX_BANK_SIZE);
        commitBank(next, entry.id);
        setFocusedIndex(next.length - 1);
        onLoad(states);
        flash(`Loaded "${name}" ✓`, true);
      } catch { flash('Invalid preset file', false); }
    };
    reader.onerror = () => flash('Could not read file', false);
    reader.readAsText(file);
    e.target.value = '';
  }, [bank, commitBank, onLoad, flash]);

  const startRename = useCallback((entry: PresetEntry, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(entry.id);
    setEditDraft(entry.name);
  }, []);

  const commitRename = useCallback(() => {
    if (!editingId) return;
    const trimmed = editDraft.trim();
    if (trimmed) commitBank(bank.map(b => b.id === editingId ? { ...b, name: trimmed } : b));
    setEditingId(null);
  }, [editingId, editDraft, bank, commitBank]);

  // ── Colour tokens ─────────────────────────────────────────────────────────
  const c = {
    header:         light ? 'rgba(0,0,0,0.30)'          : 'rgba(255,255,255,0.20)',
    empty:          light ? 'rgba(0,0,0,0.28)'          : 'rgba(255,255,255,0.18)',
    divider:        light ? 'rgba(0,0,0,0.07)'          : 'rgba(255,255,255,0.06)',
    entryBg:        light ? 'rgba(132,0,255,0.05)'      : 'rgba(255,255,255,0.04)',
    entryBgHov:     light ? 'rgba(132,0,255,0.11)'      : 'rgba(255,255,255,0.08)',
    entryBgAct:     light ? 'rgba(132,0,255,0.15)'      : 'rgba(132,0,255,0.20)',
    entryBgFocus:   light ? 'rgba(132,0,255,0.09)'      : 'rgba(255,255,255,0.07)',
    entryBorder:    light ? 'rgba(132,0,255,0.10)'      : 'rgba(255,255,255,0.06)',
    entryBorderAct: light ? 'rgba(132,0,255,0.42)'      : 'rgba(132,0,255,0.52)',
    entryBorderFocus:light? 'rgba(132,0,255,0.28)'      : 'rgba(255,255,255,0.28)',
    entryText:      light ? 'rgba(26,15,46,0.68)'       : 'rgba(255,255,255,0.65)',
    entryTextAct:   light ? 'rgba(90,0,200,0.95)'       : 'rgba(200,160,255,1.00)',
    dot:            '#22c55e',
    dotOff:         light ? 'rgba(0,0,0,0.12)'          : 'rgba(255,255,255,0.10)',
    remove:         light ? 'rgba(0,0,0,0.20)'          : 'rgba(255,255,255,0.18)',
    removeHov:      light ? 'rgba(200,0,0,0.65)'        : 'rgba(255,80,80,0.75)',
    addBg:          light ? 'rgba(132,0,255,0.08)'      : 'rgba(132,0,255,0.13)',
    addBorder:      light ? 'rgba(132,0,255,0.28)'      : 'rgba(132,0,255,0.38)',
    addText:        light ? 'rgba(90,0,200,0.85)'       : 'rgba(180,140,255,0.90)',
    saveBg:         light ? 'rgba(132,0,255,0.10)'      : 'rgba(132,0,255,0.18)',
    saveBorder:     light ? 'rgba(132,0,255,0.38)'      : 'rgba(132,0,255,0.45)',
    saveText:       light ? 'rgba(90,0,200,0.90)'       : 'rgba(200,160,255,0.95)',
    loadBg:         light ? 'rgba(0,0,0,0.05)'          : 'rgba(255,255,255,0.05)',
    loadBorder:     light ? 'rgba(0,0,0,0.13)'          : 'rgba(255,255,255,0.11)',
    loadText:       light ? 'rgba(26,15,46,0.55)'       : 'rgba(255,255,255,0.52)',
    hint:           light ? 'rgba(0,0,0,0.20)'          : 'rgba(255,255,255,0.16)',
    ok:             light ? '#166534'                   : '#22c55e',
    err:            light ? '#dc2626'                   : '#ef4444',
  };

  return (
    <div style={{
      position:      'absolute',
      inset:         0,
      display:       'flex',
      flexDirection: 'column',
      padding:       '10px 12px 12px',
      boxSizing:     'border-box',
      fontFamily:    "'Courier New', monospace",
      gap:           0,
      top:           '-230px',
    }}>

      {/* ── Bank header ── */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        marginBottom:   6,
        flexShrink:     0,
      }}>
        <span style={{
          fontSize:      10,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
          fontWeight:    700,
          color:         c.header,
        }}>
          Bank
          {bank.length > 0 && (
            <span style={{ marginLeft: 5, opacity: 0.65 }}>
              {bank.length}/{MAX_BANK_SIZE}
            </span>
          )}
        </span>

        <button
          onClick={handleSnapshot}
          title="Snapshot current pedal state into bank"
          style={{
            background:   c.addBg,
            border:      `1px solid ${c.addBorder}`,
            color:        c.addText,
            borderRadius: 6,
            padding:      '1px 9px 2px',
            fontSize:     15,
            fontWeight:   600,
            cursor:       'pointer',
            lineHeight:   1.3,
            transition:   'background 0.15s',
            fontFamily:   'inherit',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = light ? 'rgba(132,0,255,0.18)' : 'rgba(132,0,255,0.25)')}
          onMouseLeave={e => (e.currentTarget.style.background = c.addBg)}
        >+</button>
      </div>

      {/* ── Bank list ── */}
      <div style={{
        flex:           1,
        minHeight:      0,
        overflowY:      'auto',
        display:        'flex',
        flexDirection:  'column',
        gap:            3,
        marginBottom:   4,
        scrollbarWidth: 'thin',
        scrollbarColor: `rgba(132,0,255,0.25) transparent`,
      } as React.CSSProperties}>

        {bank.length === 0 ? (
          <p style={{
            margin:        0,
            fontSize:      11,
            color:         c.empty,
            lineHeight:    1.75,
            letterSpacing: '0.025em',
          }}>
            No presets in bank yet.<br />
            Use <strong style={{ fontWeight: 700 }}>+</strong> to snapshot or{' '}
            <strong style={{ fontWeight: 700 }}>↑ Load</strong> a file.
          </p>
        ) : (
          bank.map((entry, index) => {
            const isActive  = entry.id === activeId;
            const isEditing = entry.id === editingId;
            const isFocused = index === focusedIndex;

            const borderColor = isActive
              ? c.entryBorderAct
              : isFocused
              ? c.entryBorderFocus
              : c.entryBorder;

            const bgColor = isActive
              ? c.entryBgAct
              : isFocused
              ? c.entryBgFocus
              : c.entryBg;

            return (
              <div
                key={entry.id}
                onClick={() => { setFocusedIndex(index); handleApply(entry); }}
                onMouseEnter={() => setFocusedIndex(index)}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter') handleApply(entry); }}
                style={{
                  display:    'flex',
                  alignItems: 'center',
                  gap:        7,
                  padding:    '5px 6px 5px 8px',
                  borderRadius: 8,
                  border:    `1px solid ${borderColor}`,
                  background: bgColor,
                  cursor:     isEditing ? 'default' : 'pointer',
                  transition: 'background 0.13s, border-color 0.13s',
                  flexShrink: 0,
                  userSelect: 'none',
                  // Subtle left accent bar for keyboard-focused item
                  boxShadow:  isFocused && !isActive
                    ? `inset 2px 0 0 ${light ? 'rgba(132,0,255,0.45)' : 'rgba(180,140,255,0.55)'}`
                    : 'none',
                }}
              >
                {/* Active dot */}
                <span style={{
                  width:       6,
                  height:      6,
                  borderRadius:'50%',
                  flexShrink:  0,
                  background:  isActive ? c.dot : 'transparent',
                  border:     `1.5px solid ${isActive ? c.dot : c.dotOff}`,
                  boxShadow:   isActive ? `0 0 5px ${c.dot}88` : 'none',
                  transition:  'background 0.2s, box-shadow 0.2s',
                }} />

                {/* Name */}
                {isEditing ? (
                  <input
                    autoFocus
                    value={editDraft}
                    onChange={e => setEditDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter')  { e.preventDefault(); commitRename(); }
                      if (e.key === 'Escape') { e.preventDefault(); setEditingId(null); }
                    }}
                    onClick={e => e.stopPropagation()}
                    style={{
                      flex:       1,
                      minWidth:   0,
                      fontSize:   11,
                      background: 'transparent',
                      border:     'none',
                      outline:    'none',
                      color:      c.entryTextAct,
                      fontFamily: 'inherit',
                      padding:    0,
                    }}
                  />
                ) : (
                  <span
                    onDoubleClick={e => startRename(entry, e)}
                    title={`${entry.name} — double-click to rename`}
                    style={{
                      flex:          1,
                      minWidth:      0,
                      overflow:      'hidden',
                      textOverflow:  'ellipsis',
                      whiteSpace:    'nowrap',
                      fontSize:      11,
                      letterSpacing: '0.025em',
                      fontWeight:    isActive ? 700 : 400,
                      color:         isActive ? c.entryTextAct : c.entryText,
                      transition:    'color 0.15s',
                    }}
                  >
                    {entry.name}
                  </span>
                )}

                {/* Index hint when keyboard-focused */}
                {isFocused && !isActive && !isEditing && (
                  <span style={{
                    fontSize:      9,
                    color:         light ? 'rgba(132,0,255,0.5)' : 'rgba(180,140,255,0.45)',
                    letterSpacing: '0.04em',
                    flexShrink:    0,
                  }}>
                    ↵
                  </span>
                )}

                {/* Remove button */}
                <button
                  onClick={e => handleRemove(entry.id, e)}
                  title="Remove from bank"
                  style={{
                    background: 'none',
                    border:     'none',
                    cursor:     'pointer',
                    color:      c.remove,
                    fontSize:   10,
                    padding:    '0 2px',
                    lineHeight: 1,
                    flexShrink: 0,
                    transition: 'color 0.13s',
                    fontFamily: 'inherit',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = c.removeHov)}
                  onMouseLeave={e => (e.currentTarget.style.color = c.remove)}
                >✕</button>
              </div>
            );
          })
        )}
      </div>

      {/* ── Keyboard hint ── */}
      {bank.length > 0 && (
        <div style={{
          fontSize:      9,
          color:         c.hint,
          letterSpacing: '0.04em',
          textAlign:     'center',
          marginBottom:  4,
          flexShrink:    0,
        }}>
          W / S  ·  ↑↓ navigate  ·  Enter apply
        </div>
      )}

      {/* ── Divider ── */}
      <div style={{ height: 1, background: c.divider, flexShrink: 0, marginBottom: 6 }} />

      {/* ── Status message ── */}
      {status && (
        <p style={{
          margin:        '0 0 6px',
          fontSize:      11,
          fontWeight:    600,
          letterSpacing: '0.03em',
          color:         status.ok ? c.ok : c.err,
          flexShrink:    0,
          overflow:      'hidden',
          textOverflow:  'ellipsis',
          whiteSpace:    'nowrap',
        }}>
          {status.msg}
        </p>
      )}

      {/* ── Action buttons ── */}
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button
          onClick={handleSave}
          style={{
            flex:          1,
            padding:       '7px 0',
            background:    c.saveBg,
            border:       `1px solid ${c.saveBorder}`,
            borderRadius:  8,
            color:         c.saveText,
            fontSize:      11,
            fontWeight:    700,
            cursor:        'pointer',
            letterSpacing: '0.06em',
            transition:    'background 0.18s',
            fontFamily:    "'Courier New', monospace",
          }}
          onMouseEnter={e => (e.currentTarget.style.background = light ? 'rgba(132,0,255,0.22)' : 'rgba(132,0,255,0.30)')}
          onMouseLeave={e => (e.currentTarget.style.background = c.saveBg)}
        >↓ Save</button>

        <button
          onClick={() => fileInputRef.current?.click()}
          style={{
            flex:          1,
            padding:       '7px 0',
            background:    c.loadBg,
            border:       `1px solid ${c.loadBorder}`,
            borderRadius:  8,
            color:         c.loadText,
            fontSize:      11,
            fontWeight:    700,
            cursor:        'pointer',
            letterSpacing: '0.06em',
            transition:    'background 0.18s, color 0.18s',
            fontFamily:    "'Courier New', monospace",
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = light ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.10)';
            e.currentTarget.style.color      = light ? 'rgba(26,15,46,0.85)' : 'rgba(255,255,255,0.80)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = c.loadBg;
            e.currentTarget.style.color      = c.loadText;
          }}
        >↑ Load</button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      </div>
    </div>
  );
};

export default PresetsCard;