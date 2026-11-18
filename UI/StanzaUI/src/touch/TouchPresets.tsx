/**
 * The preset bank as a grid of large buttons: one tap loads a whole pedalboard.
 * Same bank, file format and limits as PresetsCard.tsx on the desktop.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PedalState } from "../PedalOverlay";
import type { PresetEntry } from "../PresetsCard";
import { updateProfile, useProfileValue } from "../profileStore";
import { ConfirmButton, Icons } from "./controls";

const MAX_BANK_SIZE = 12;

function autoName(): string {
  const d = new Date();
  const mon = d.toLocaleString("en-AU", { month: "short" });
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${mon} ${hh}:${mm}`;
}

function cleanFilename(raw: string): string {
  const stem = raw.replace(/\.json$/i, "");
  const m = stem.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]} ${m[4]}:${m[5]}`;
  return stem.replace(/^stanza-preset-/, "") || stem;
}

export default function TouchPresets({
  pedalStates, onLoad, onPresetSaved,
}: {
  pedalStates: Record<string, PedalState>;
  onLoad: (states: Record<string, PedalState>) => void;
  onPresetSaved?: () => void;
}) {
  const bank = useProfileValue(p => p.presets);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!status) return;
    const id = setTimeout(() => setStatus(null), 2400);
    return () => clearTimeout(id);
  }, [status]);

  useEffect(() => { if (bank.length === 0) setEditMode(false); }, [bank.length]);

  const flash = (msg: string, ok: boolean) => setStatus({ msg, ok });
  const hasBoard = Object.keys(pedalStates).length > 0;

  const apply = useCallback((entry: PresetEntry) => {
    setActiveId(entry.id);
    onLoad(entry.pedals);
    setStatus({ msg: `Loaded “${entry.name}”`, ok: true });
  }, [onLoad]);

  const add = (entry: PresetEntry) => {
    updateProfile({ presets: [...bank, entry].slice(-MAX_BANK_SIZE) });
    setActiveId(entry.id);
  };

  const snapshot = () => {
    if (!hasBoard) { flash("Set up a pedal first", false); return; }
    const entry: PresetEntry = { id: String(Date.now()), name: autoName(), pedals: { ...pedalStates } };
    add(entry);
    flash(`Saved “${entry.name}”`, true);
  };

  const saveFile = () => {
    if (!hasBoard) { flash("Set up a pedal first", false); return; }
    try {
      const now = new Date();
      const name = autoName();
      const payload = { version: 1, savedAt: now.toISOString(), appName: "StanzaUI", pedals: pedalStates };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `stanza-preset-${now.toISOString().slice(0, 19).replace(/[T:]/g, "-")}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      add({ id: String(Date.now()), name, pedals: { ...pedalStates } });
      flash(`Saved “${name}” to a file`, true);
      onPresetSaved?.();
    } catch { flash("Couldn't save the file", false); }
  };

  const loadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const name = cleanFilename(file.name);
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const raw = JSON.parse(ev.target?.result as string);
        const states: Record<string, PedalState> = raw.pedals ?? raw;
        if (typeof states !== "object" || states === null) throw new Error();
        add({ id: String(Date.now()), name, pedals: states });
        onLoad(states);
        flash(`Loaded “${name}”`, true);
      } catch { flash("That isn't a preset file", false); }
    };
    reader.onerror = () => flash("Couldn't read that file", false);
    reader.readAsText(file);
  };

  const remove = (id: string) => {
    updateProfile({ presets: bank.filter(b => b.id !== id) });
    if (activeId === id) setActiveId(null);
  };

  const commitRename = () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (name) updateProfile({ presets: bank.map(b => (b.id === renaming.id ? { ...b, name } : b)) });
    setRenaming(null);
  };

  // W / S / arrows + Enter, as on the desktop card (footswitch-friendly)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || renaming || bank.length === 0) return;
      const n = bank.length;
      if (e.key === "w" || e.key === "W" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocused(p => (p === null ? n - 1 : (p - 1 + n) % n));
      } else if (e.key === "s" || e.key === "S" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocused(p => (p === null ? 0 : (p + 1) % n));
      } else if (e.key === "Enter" && focused !== null && bank[focused]) {
        e.preventDefault();
        apply(bank[focused]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bank, focused, renaming, apply]);

  return (
    <div className="ts-presets">
      <div className="ts-bar">
        <span className="ts-bar__title">
          PRESETS <span className="ts-bar__count">{bank.length}/{MAX_BANK_SIZE}</span>
        </span>
        {status && <span className={`ts-toast${status.ok ? "" : " is-bad"}`} role="status">{status.msg}</span>}
        <span className="ts-bar__spacer" />
        <button type="button" className="ts-btn ts-btn--accent" onClick={snapshot} title="Keep the current pedalboard in the bank">
          + SNAPSHOT
        </button>
        <button type="button" className="ts-btn" onClick={saveFile} title="Save the current pedalboard to a file">↓ FILE</button>
        <button type="button" className="ts-btn" onClick={() => fileRef.current?.click()} title="Load a preset file">↑ FILE</button>
        <button
          type="button"
          className={`ts-btn${editMode ? " is-on" : ""}`}
          onClick={() => { setEditMode(v => !v); setRenaming(null); }}
          disabled={bank.length === 0}
          aria-pressed={editMode}
        >
          {editMode ? "DONE" : "EDIT"}
        </button>
        <input ref={fileRef} type="file" accept=".json" hidden onChange={loadFile} />
      </div>

      {bank.length === 0 ? (
        <div className="ts-empty">
          <strong>No presets yet</strong>
          <span>Dial in your pedals, then tap <b>+ SNAPSHOT</b> to keep the whole board.</span>
        </div>
      ) : (
        <div className="ts-presets__grid">
          {bank.map((entry, index) => {
            const active = entry.id === activeId;
            const cls = `ts-preset${active ? " is-active" : ""}${index === focused ? " is-focused" : ""}`;
            if (editMode) {
              return (
                <div key={entry.id} className={`${cls} is-editing`}>
                  {renaming?.id === entry.id ? (
                    <input
                      autoFocus
                      className="ts-input"
                      value={renaming.name}
                      maxLength={32}
                      onChange={e => setRenaming({ id: entry.id, name: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={e => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="ts-preset__name ts-preset__name--edit"
                      onClick={() => setRenaming({ id: entry.id, name: entry.name })}
                      title="Rename"
                    >
                      {Icons.edit}
                      <span>{entry.name}</span>
                    </button>
                  )}
                  <ConfirmButton
                    className="ts-btn ts-btn--icon ts-btn--bad"
                    onConfirm={() => remove(entry.id)}
                    confirmLabel="DEL?"
                    title="Remove from the bank"
                  >
                    {Icons.trash}
                  </ConfirmButton>
                </div>
              );
            }
            return (
              <button key={entry.id} type="button" className={cls} onClick={() => { setFocused(index); apply(entry); }}>
                <span className="ts-preset__slot">{index + 1}</span>
                <span className="ts-preset__name">{entry.name}</span>
                <span className="ts-preset__lamp" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
