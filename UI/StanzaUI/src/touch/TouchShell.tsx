/**
 * TouchShell — the whole app on a small touchscreen (800 × 480 and thereabouts).
 *
 * App.tsx renders this instead of the desktop dashboard when its compact check
 * passes; nothing here runs at desktop sizes. One feature fills the screen at a
 * time and a tab bar along the bottom reaches any other in a single tap, so it
 * can be worked with one hand while the other holds an instrument.
 *
 * Every screen stays mounted while hidden: the metronome keeps clicking, a
 * backing track keeps playing and a half-edited song is still there on return.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import DashboardChordBank from "../DashboardChordBank";
import DashboardTuner from "../DashboardTuner";
import RustStreamExample from "../RustStreamExample";
import { PEDAL_DEFS, syncToHardware, type PedalState } from "../PedalOverlay";
import type { AppSettings } from "../Settings";
import type { Theme } from "../profileStore";
import { useTakes } from "../takes";
import { useSerialStream } from "../useSerialStream";
import { Icons, ScaleBox, Segmented } from "./controls";
import TouchLooper, { LOOPER_META } from "./TouchLooper";
import TouchMetronome, { type MetronomeStatus } from "./TouchMetronome";
import TouchPedals from "./TouchPedals";
import TouchPresets from "./TouchPresets";
import TouchSpectrum from "./TouchSpectrum";
import TouchSystem from "./TouchSystem";
import { useLooper } from "./useLooper";
import "./TouchShell.css";

type ScreenId = "tuner" | "metro" | "songs" | "notes" | "pedals" | "looper" | "presets" | "system";

const SCREENS: { id: ScreenId; label: string; icon: React.ReactNode }[] = [
  { id: "tuner",   label: "Tuner",   icon: Icons.tuner },
  { id: "metro",   label: "Metro",   icon: Icons.metro },
  { id: "songs",   label: "Songs",   icon: Icons.songs },
  { id: "notes",   label: "Notes",   icon: Icons.notes },
  { id: "pedals",  label: "Pedals",  icon: Icons.pedals },
  { id: "looper",  label: "Looper",  icon: Icons.looper },
  { id: "presets", label: "Presets", icon: Icons.presets },
  { id: "system",  label: "System",  icon: Icons.system },
];

const LS_SCREEN = "stanza-touch-screen";
/** The dashboard's song panel is drawn for a mouse; this is how much larger it is shown here. */
const SONGS_SCALE = 1.8;

type TunerView = "tuner" | "spectrum";
const TUNER_VIEWS: { id: TunerView; label: string }[] = [
  { id: "tuner", label: "TUNER" },
  { id: "spectrum", label: "SPECTRUM" },
];

function savedScreen(): ScreenId {
  try {
    const id = localStorage.getItem(LS_SCREEN);
    if (id && id !== "system" && SCREENS.some(s => s.id === id)) return id as ScreenId;
  } catch { /* storage is a nicety */ }
  return "tuner";
}

export interface TouchShellProps {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  username: string;
  settings: AppSettings;
  onSettingsChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  pedalStates: Record<string, PedalState>;
  onPedalStatesChange: (states: Record<string, PedalState>) => void;
  onPresetSaved: () => void;
  onFullscreen: () => void;
}

export default function TouchShell({
  theme, onThemeChange, username, settings, onSettingsChange,
  pedalStates, onPedalStatesChange, onPresetSaved, onFullscreen,
}: TouchShellProps) {
  const { connected } = useSerialStream(() => {});
  const looper = useLooper();
  const takes = useTakes();

  // Nothing to listen to yet → open on the screen with the Connect button
  const [screen, setScreen] = useState<ScreenId>(() => (connected ? savedScreen() : "system"));
  const [tunerView, setTunerView] = useState<TunerView>("tuner");
  const [metro, setMetro] = useState<MetronomeStatus>({ running: false, beat: -1, accented: false });

  const go = useCallback((id: ScreenId) => {
    setScreen(id);
    if (id !== "system") { try { localStorage.setItem(LS_SCREEN, id); } catch { /* fine */ } }
  }, []);

  // Loading a preset sets every pedal on the board, as on the desktop
  const loadPreset = useCallback(async (states: Record<string, PedalState>) => {
    onPedalStatesChange(states);
    for (const [name, state] of Object.entries(states)) {
      const def = PEDAL_DEFS[name];
      if (def) await syncToHardware(name, def, state);
    }
  }, [onPedalStatesChange]);

  // A hover that sticks after a tap looks like a pressed button; keep :hover styles for real mice only
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onDown = (e: PointerEvent) => { root.dataset.pointer = e.pointerType === "mouse" ? "mouse" : "touch"; };
    root.addEventListener("pointerdown", onDown, true);
    return () => root.removeEventListener("pointerdown", onDown, true);
  }, []);

  const pedalsOn = Object.values(pedalStates).filter(s => s.enabled).length;
  const loopMeta = LOOPER_META[looper.info.state] ?? LOOPER_META.Idle;

  const badge = (id: ScreenId): React.ReactNode => {
    switch (id) {
      case "metro":
        return metro.running
          ? <span key={metro.beat} className={`ts-badge ts-badge--beat${metro.accented ? " is-accent" : ""}`} />
          : null;
      case "notes":
        return takes.recording ? <span className="ts-badge ts-badge--rec" /> : null;
      case "pedals":
        return pedalsOn > 0 ? <span className="ts-badge ts-badge--count">{pedalsOn}</span> : null;
      case "looper":
        return looper.info.state !== "Idle"
          ? <span className={`ts-badge ts-badge--loop ts-looper--${loopMeta.tone}${loopMeta.pulse ? " is-pulsing" : ""}`} />
          : null;
      case "system":
        return <span className={`ts-badge ${connected ? "ts-badge--good" : "ts-badge--off"}`} />;
      default:
        return null;
    }
  };

  const connectHint = !connected && (
    <button type="button" className="ts-connect-hint" onClick={() => setScreen("system")}>
      <span className="ts-pill__dot" />
      No input · tap to connect
    </button>
  );

  const screenClass = (id: ScreenId) => `ts-screen ts-screen--${id}${screen === id ? " is-active" : ""}`;
  const hidden = (id: ScreenId) => (screen === id ? undefined : true);

  return (
    <div ref={rootRef} className={`ts-root${settings.animations ? "" : " ts-root--still"}`} data-screen={screen}>
      <div className="ts-stage">
        {/* Logo over the page background, under every screen */}
        <img
          className="ts-logo"
          src={theme === "dark" ? "/STANZA_W_TP.png" : "/STANZA_W_TP.png"}
          alt=""
          aria-hidden="true"
          draggable={false}
        />

        <section className={screenClass("tuner")} aria-hidden={hidden("tuner")}>
          <div className="ts-panel ts-tuner">
            <div className="ts-bar">
              <Segmented label="Tuner view" options={TUNER_VIEWS} value={tunerView} onChange={setTunerView} />
              <span className="ts-bar__spacer" />
              {connectHint}
            </div>
            <div className="ts-tuner__body">
              {tunerView === "tuner"
                ? <DashboardTuner />
                : <TouchSpectrum active={screen === "tuner"} />}
            </div>
          </div>
        </section>

        <section className={screenClass("metro")} aria-hidden={hidden("metro")}>
          <div className="ts-panel">
            <TouchMetronome onStatus={setMetro} />
          </div>
        </section>

        <section className={screenClass("songs")} aria-hidden={hidden("songs")}>
          <div className="ts-panel ts-host ts-songs magic-bento-card da-root">
            <ScaleBox scale={SONGS_SCALE}>
              {size => <DashboardChordBank size={size} />}
            </ScaleBox>
          </div>
        </section>

        <section className={screenClass("notes")} aria-hidden={hidden("notes")}>
          <div className="ts-panel ts-host ts-notes magic-bento-card">
            <RustStreamExample />
            {connectHint}
          </div>
        </section>

        <section className={screenClass("pedals")} aria-hidden={hidden("pedals")}>
          <TouchPedals
            pedalStates={pedalStates}
            onPedalStatesChange={onPedalStatesChange}
            looper={looper}
            onOpenLooper={() => go("looper")}
          />
        </section>

        <section className={screenClass("looper")} aria-hidden={hidden("looper")}>
          <div className="ts-panel">
            <TouchLooper looper={looper} />
          </div>
        </section>

        <section className={screenClass("presets")} aria-hidden={hidden("presets")}>
          <div className="ts-panel">
            <TouchPresets pedalStates={pedalStates} onLoad={loadPreset} onPresetSaved={onPresetSaved} />
          </div>
        </section>

        <section className={screenClass("system")} aria-hidden={hidden("system")}>
          <TouchSystem
            theme={theme}
            onThemeChange={onThemeChange}
            username={username}
            settings={settings}
            onSettingsChange={onSettingsChange}
            pedalStates={pedalStates}
            onFullscreen={onFullscreen}
            onConnected={() => go(savedScreen())}
          />
        </section>

      </div>

      <nav className="ts-nav" aria-label="Screens">
        {SCREENS.map(s => (
          <button
            key={s.id}
            type="button"
            className={`ts-nav__item${screen === s.id ? " is-active" : ""}`}
            aria-current={screen === s.id ? "page" : undefined}
            onClick={() => go(s.id)}
          >
            <span className="ts-nav__icon">
              {s.icon}
              {badge(s.id)}
            </span>
            <span className="ts-nav__label">{s.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
