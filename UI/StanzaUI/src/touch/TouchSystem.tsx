/**
 * Everything the desktop keeps in the dock: the audio input and its Connect
 * button, plus the way into Profile and Settings.
 */

import { useEffect, useRef, useState } from "react";
import Profile from "../Profile";
import Settings, { type AppSettings } from "../Settings";
import type { PedalState } from "../PedalOverlay";
import type { Theme } from "../profileStore";
import { isMicSource, MIC_PREFIX, sourceName, useSerialStream } from "../useSerialStream";
import { Icons, Segmented } from "./controls";

type Page = "home" | "profile" | "settings";

const THEMES: { id: Theme; label: string }[] = [
  { id: "dark", label: "DARK" },
  { id: "light", label: "LIGHT" },
];

export default function TouchSystem({
  theme, onThemeChange, username, settings, onSettingsChange, pedalStates, onFullscreen, onConnected,
}: {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  username: string;
  settings: AppSettings;
  onSettingsChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  pedalStates: Record<string, PedalState>;
  onFullscreen: () => void;
  /** Called once a connection made from this screen is up. */
  onConnected: () => void;
}) {
  const [page, setPage] = useState<Page>("home");
  const { ports, mics, selectedPort, setSelectedPort, connected, connect, disconnect, refreshPorts } = useSerialStream(() => {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const none = ports.length === 0 && mics.length === 0;
  const mic = isMicSource(selectedPort);

  const onConnect = async () => {
    if (busy || !selectedPort) return;
    setBusy(true);
    setError("");
    await connect();
    // `connect` reports failure only by leaving the shared state unconnected; let that state reach this render
    await new Promise(resolve => setTimeout(resolve, 60));
    if (!alive.current) return;
    setBusy(false);
    if (connectedRef.current) onConnected();
    else setError(`Couldn't open ${sourceName(selectedPort)}. Is it in use or unplugged?`);
  };

  const pick = (source: string) => { setError(""); setSelectedPort(source); };

  if (page !== "home") {
    return (
      <div className="ts-subpage">
        <div className="ts-bar">
          <button type="button" className="ts-btn ts-btn--icon" onClick={() => setPage("home")} aria-label="Back">
            {Icons.back}
          </button>
          <span className="ts-bar__title">{page === "profile" ? "PROFILE" : "SETTINGS"}</span>
        </div>
        <div className="ts-subpage__body">
          {page === "profile"
            ? <Profile pedalStates={pedalStates} />
            : (
              <Settings
                theme={theme}
                onThemeChange={onThemeChange}
                username={username}
                settings={settings}
                onSettingsChange={onSettingsChange}
              />
            )}
        </div>
      </div>
    );
  }

  const sourceButton = (source: string, name: string) => (
    <button
      key={source}
      type="button"
      className={`ts-source${source === selectedPort ? " is-on" : ""}`}
      onClick={() => pick(source)}
      disabled={connected}
      aria-pressed={source === selectedPort}
    >
      <span className="ts-source__radio" />
      <span className="ts-source__name">{name}</span>
    </button>
  );

  return (
    <div className="ts-system">
      <section className="ts-card ts-system__input">
        <div className="ts-card__head">
          <span className="ts-card__title">AUDIO INPUT</span>
          <span className={`ts-pill${connected ? " is-good" : ""}`}>
            <span className="ts-pill__dot" />
            {connected ? `${mic ? "Mic" : "Live"} · ${sourceName(selectedPort)}` : "Not connected"}
          </span>
        </div>

        <div className="ts-system__sources">
          {none && <div className="ts-system__none">No board or microphone found. Plug one in, then refresh.</div>}
          {ports.length > 0 && <div className="ts-system__group">STANZA BOARD</div>}
          {ports.map(p => sourceButton(p, p))}
          {mics.length > 0 && <div className="ts-system__group">MICROPHONE</div>}
          {mics.map(m => sourceButton(MIC_PREFIX + m, m))}
        </div>

        {error && <div className="ts-system__error" role="alert">{error}</div>}

        <div className="ts-system__actions">
          <button
            type="button"
            className="ts-btn ts-btn--icon"
            onClick={() => { setError(""); void refreshPorts(); }}
            disabled={connected}
            aria-label="Look for inputs again"
          >
            {Icons.refresh}
          </button>
          {connected ? (
            <button type="button" className="ts-btn ts-btn--big ts-btn--bad" onClick={disconnect}>DISCONNECT</button>
          ) : (
            <button
              type="button"
              className="ts-btn ts-btn--big ts-btn--primary"
              onClick={() => { void onConnect(); }}
              disabled={busy || !selectedPort}
            >
              {busy ? "CONNECTING…" : "CONNECT"}
            </button>
          )}
        </div>
      </section>

      <section className="ts-system__side">
        <button type="button" className="ts-card ts-system__profile" onClick={() => setPage("profile")}>
          <span className="ts-avatar">{username?.[0]?.toUpperCase() || "?"}</span>
          <span className="ts-system__who">
            <strong>{username || "Unnamed"}</strong>
            <span>Profile, songs &amp; stats</span>
          </span>
          <span className="ts-chevron">›</span>
        </button>

        <div className="ts-card ts-system__theme">
          <span className="ts-card__title">THEME</span>
          <Segmented label="Theme" options={THEMES} value={theme} onChange={onThemeChange} />
        </div>

        <div className="ts-system__buttons">
          <button type="button" className="ts-btn ts-btn--tile" onClick={() => setPage("settings")}>
            {Icons.system}
            SETTINGS
          </button>
          <button type="button" className="ts-btn ts-btn--tile" onClick={onFullscreen}>
            {Icons.fullscreen}
            FULLSCREEN
          </button>
        </div>
      </section>
    </div>
  );
}
