/**
 * The pedalboard for a fingertip: every pedal on one screen with its own
 * on / off switch, and a page of wide sliders behind each one.
 * Pedal IDs, knob order and ranges all come from PedalOverlay.tsx.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_ITEMS, type GalleryItem } from "../CircularGallery";
import {
  PEDAL_DEFS, buildDefaultState, syncToHardware,
  type KnobDef, type PedalDef, type PedalState,
} from "../PedalOverlay";
import { ConfirmButton, Icons, TouchSlider } from "./controls";
import { LOOPER_META } from "./TouchLooper";
import type { Looper } from "./useLooper";

const LOOPER = "Looper";
/** Knob moves reach the board at most this often, as on the desktop overlay. */
const SYNC_DELAY_MS = 80;

function knobText(def: KnobDef, value: number): string {
  const shown = value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(def.decimals ?? 1);
  return `${shown}${def.unit ?? ""}`;
}

export default function TouchPedals({
  pedalStates, onPedalStatesChange, looper, onOpenLooper,
}: {
  pedalStates: Record<string, PedalState>;
  onPedalStatesChange: (states: Record<string, PedalState>) => void;
  looper: Looper;
  onOpenLooper: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  // Slider moves arrive faster than React re-renders, so the latest board lives in a ref too
  const statesRef = useRef(pedalStates);
  statesRef.current = pedalStates;
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => () => { Object.values(timers.current).forEach(clearTimeout); }, []);

  const stateOf = (name: string, def: PedalDef) => statesRef.current[name] ?? buildDefaultState(def);

  const commit = useCallback((name: string, def: PedalDef, next: PedalState, now: boolean) => {
    const all = { ...statesRef.current, [name]: next };
    statesRef.current = all;
    onPedalStatesChange(all);
    clearTimeout(timers.current[name]);
    if (now) void syncToHardware(name, def, next);
    else timers.current[name] = setTimeout(() => { void syncToHardware(name, def, statesRef.current[name] ?? next); }, SYNC_DELAY_MS);
  }, [onPedalStatesChange]);

  const toggle = (name: string, def: PedalDef) => {
    const cur = stateOf(name, def);
    commit(name, def, { ...cur, enabled: !cur.enabled }, true);
  };

  const open = (name: string, def: PedalDef) => {
    // Push what the screen shows, so the board and the sliders start out agreeing
    void syncToHardware(name, def, stateOf(name, def));
    setEditing(name);
  };

  const editItem = editing ? DEFAULT_ITEMS.find(i => i.text === editing) : undefined;
  const editDef = editing ? PEDAL_DEFS[editing] : undefined;

  if (editItem && editDef) {
    const state = stateOf(editItem.text, editDef);
    return (
      <PedalEditor
        item={editItem}
        def={editDef}
        state={state}
        onBack={() => setEditing(null)}
        onToggle={() => toggle(editItem.text, editDef)}
        onKnob={(key, v) => {
          const cur = stateOf(editItem.text, editDef);
          commit(editItem.text, editDef, { ...cur, values: { ...cur.values, [key]: v } }, false);
        }}
        onReset={() => commit(editItem.text, editDef, { ...buildDefaultState(editDef), enabled: state.enabled }, true)}
      />
    );
  }

  const loopMeta = LOOPER_META[looper.info.state] ?? LOOPER_META.Idle;

  return (
    <div className="ts-pedals">
      {DEFAULT_ITEMS.map(item => {
        if (item.text === LOOPER) {
          return (
            <div key={item.text} className={`ts-pedal ts-pedal--looper ts-looper--${loopMeta.tone}`}>
              <button type="button" className="ts-pedal__face" onClick={onOpenLooper} aria-label="Open the looper">
                <span className="ts-pedal__img" style={{ backgroundImage: `url("${item.image}")` }} />
                <span className="ts-pedal__name">{item.text}</span>
                <span className="ts-pedal__kind">Loop station</span>
              </button>
              <button type="button" className="ts-pedal__switch ts-pedal__switch--looper" onClick={onOpenLooper}>
                <span className="ts-pedal__lamp" />
                {loopMeta.label}
              </button>
            </div>
          );
        }
        const def = PEDAL_DEFS[item.text];
        if (!def) return null;
        const on = pedalStates[item.text]?.enabled ?? false;
        return (
          <div key={item.text} className={`ts-pedal${on ? " is-on" : ""}`}>
            <button
              type="button"
              className="ts-pedal__face"
              onClick={() => open(item.text, def)}
              aria-label={`Adjust ${item.text}, ${def.label}`}
            >
              <span className="ts-pedal__img" style={{ backgroundImage: `url("${item.image}")` }} />
              <span className="ts-pedal__name">{item.text}</span>
              <span className="ts-pedal__kind">{def.label}</span>
            </button>
            <button
              type="button"
              className="ts-pedal__switch"
              onClick={() => toggle(item.text, def)}
              aria-pressed={on}
              aria-label={`${item.text} ${on ? "on" : "off"}`}
            >
              <span className="ts-pedal__lamp" />
              {on ? "ON" : "OFF"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function PedalEditor({
  item, def, state, onBack, onToggle, onKnob, onReset,
}: {
  item: GalleryItem;
  def: PedalDef;
  state: PedalState;
  onBack: () => void;
  onToggle: () => void;
  onKnob: (key: string, value: number) => void;
  onReset: () => void;
}) {
  const { enabled, values } = state;
  const cols = def.knobs.length <= 3 ? 1 : def.knobs.length <= 6 ? 2 : 3;

  return (
    <div className="ts-editor">
      <div className="ts-editor__head">
        <button type="button" className="ts-btn ts-btn--icon" onClick={onBack} aria-label="Back to all pedals">
          {Icons.back}
        </button>
        <span className="ts-editor__img" style={{ backgroundImage: `url("${item.image}")` }} />
        <div className="ts-editor__title">
          <span>{def.label}</span>
          <strong>{item.text}</strong>
        </div>
        <ConfirmButton className="ts-btn" onConfirm={onReset} confirmLabel="RESET ALL?" title="Put every control back to its default">
          RESET
        </ConfirmButton>
        <button
          type="button"
          className={`ts-power${enabled ? " is-on" : ""}`}
          onClick={onToggle}
          aria-pressed={enabled}
        >
          <span className="ts-pedal__lamp" />
          {enabled ? "ON" : "OFF"}
        </button>
      </div>

      <div className={`ts-editor__knobs ts-editor__knobs--${cols}${enabled ? "" : " is-off"}`}>
        {def.knobs.map(knob => {
          const value = values[knob.key] ?? knob.defaultValue;
          return (
            <div className="ts-field" key={knob.key}>
              <div className="ts-field__head">
                <span>{knob.label.toUpperCase()}</span>
                <span className="ts-field__value">{enabled ? knobText(knob, value) : "—"}</span>
              </div>
              <TouchSlider
                label={knob.label}
                value={value}
                min={knob.min}
                max={knob.max}
                disabled={!enabled}
                onChange={v => onKnob(knob.key, v)}
                onReset={() => onKnob(knob.key, knob.defaultValue)}
              />
            </div>
          );
        })}
      </div>

      <div className="ts-editor__hint">
        {enabled ? "Slide to adjust · double-tap a slider to reset it" : "Switch the pedal on to adjust it"}
      </div>
    </div>
  );
}
