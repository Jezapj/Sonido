import { useRef, useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

import FloatingLines from './FloatingLines';
import { VscHome, VscArchive, VscAccount, VscSettingsGear } from "react-icons/vsc";
import Dock from './Dock';
import ShapeGrid from './ShapeGrid';
import MagicBento from './MagicBento';
import ModelViewer from './ModelViewer';
import CircularText from './CircularText';
import Profile from './Profile';
import Settings, { AppSettings, DEFAULT_SETTINGS } from './Settings';
import TextType from './TextType';
import type { PedalState } from './PedalOverlay';

type Theme = 'dark' | 'light';

// ── localStorage helpers ──────────────────────────────────────────────────────

const LS_SETTINGS  = 'stanza-settings';
const LS_SESSIONS  = 'stanza-sessions';
const LS_PRESETS   = 'stanza-presets-saved';

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

function loadInt(key: string, fallback = 0): number {
  return parseInt(localStorage.getItem(key) ?? String(fallback), 10) || fallback;
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const greetMsgRef = useRef("");
  const nameRef     = useRef("");

  const [view,      setView]      = useState("landing");
  const [bgVariant, setBgVariant] = useState(0);
  const [username,  setUsername]  = useState("");
  const [theme,     setTheme]     = useState<Theme>('dark');

  // ── Settings — lifted so every component that needs them can read them ──────
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const handleSettingsChange = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      setSettings(prev => {
        const next = { ...prev, [key]: value };
        localStorage.setItem(LS_SETTINGS, JSON.stringify(next));
        return next;
      });
    },
    [],
  );

  // ── Pedal state — lifted so Profile can read it ───────────────────────────
  const [pedalStates, setPedalStates] = useState<Record<string, PedalState>>({});

  // ── Persistent counters ───────────────────────────────────────────────────
  const [sessionCount,    setSessionCount]    = useState(() => loadInt(LS_SESSIONS));
  const [presetSavedCount, setPresetSavedCount] = useState(() => loadInt(LS_PRESETS));

  const handlePresetSaved = useCallback(() => {
    setPresetSavedCount(prev => {
      const next = prev + 1;
      localStorage.setItem(LS_PRESETS, String(next));
      return next;
    });
  }, []);

  // Apply theme attribute so CSS [data-theme] selectors fire globally
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Handle theme change — also store in settings for persistence
  const handleThemeChange = useCallback((t: Theme) => {
    setTheme(t);
  }, []);

  const items = [
    { icon: <VscHome size={18} />,         label: 'Home',     onClick: () => navigate("main")     },
    { icon: <VscArchive size={18} />,      label: 'Board',    onClick: () => navigate("board")    },
    { icon: <VscAccount size={18} />,      label: 'Profile',  onClick: () => navigate("profile")  },
    { icon: <VscSettingsGear size={18} />, label: 'Settings', onClick: () => navigate("settings") },
  ];

  function switchBg() {
    setBgVariant(prev => (prev === 0 ? 1 : 0));
  }

  async function enter() {
    greetMsgRef.current = await invoke("greet", { name: nameRef.current });
    setUsername(nameRef.current.toUpperCase());
    // Increment persistent session counter
    setSessionCount(prev => {
      const next = prev + 1;
      localStorage.setItem(LS_SESSIONS, String(next));
      return next;
    });
    setTimeout(() => { setView("main"); switchBg(); }, 800);
  }

  function navigate(location: string) {
    setTimeout(() => {
      setView(location);
      if (location === "main" || location === "board") switchBg();
    }, 200);
  }

  const handleToggle = () => { invoke('toggle_fullscreen'); };

  // ── gridSpeed slider (1–20) → ShapeGrid speed (0.1–2.0) ──────────────────
  const shapeGridSpeed = settings.gridSpeed / 10;

  // ── Shared floating-lines background ─────────────────────────────────────
  // Re-evaluated each render so settings.parallax is always current.
  const floatingLinesBg = (
    <FloatingLines
      enabledWaves={["top", "middle", "bottom"]}
      lineCount={8}
      lineDistance={8}
      bendRadius={8}
      bendStrength={-2}
      interactive={true}
      parallax={settings.parallax}
      animationSpeed={1}
      gradientStart="#2d0630"
      gradientMid="#1f5c70"
      gradientEnd="#042d13"
    />
  );

  const showDock = view !== "landing";

  return (
    <>
      {/* ── Global background ── */}
      <div style={{ position: 'absolute', width: '100%', height: '100%', zIndex: -1 }}>
        <div style={{
          position: 'absolute', width: '100%', height: '100%',
          opacity: bgVariant === 0 ? 1 : 1,
          transition: 'opacity 0.6s ease-in-out', pointerEvents: 'none',
        }}>
          {theme === "dark"
            ? floatingLinesBg
            : <div style={{ width: '100%', height: '100%', backgroundColor: 'rgb(200,200,200)' }} />}
        </div>
        <div style={{
          position: 'absolute', width: '100%', height: '100%',
          opacity: bgVariant === 1 ? 1 : 0.3,
          transition: 'opacity 0.6s ease-in-out', pointerEvents: 'none',
        }}>
          {/* ShapeGrid speed is driven by the Settings slider */}
          <ShapeGrid
            speed={shapeGridSpeed}
            squareSize={40}
            direction="diagonal"
            borderColor={theme === 'light' ? 'rgba(100,100,100,0.7)' : 'rgba(255,255,255,0.3)'}
            hoverFillColor="#222"
            shape="square"
            hoverTrailAmount={0}
          />
          {floatingLinesBg}
        </div>
      </div>

      {/* ── LANDING ── */}
      {view === "landing" && (
        <>
          <button onClick={handleToggle} style={{ position: 'fixed', top: 20, right: 20, zIndex: 1 }}>
            Toggle Fullscreen
          </button>
          <main className="container">
            <TextType
              typingSpeed={75}
              pauseDuration={1500}
              showCursor
              cursorCharacter="|"
              text={["Interactive Audio DSP", "Build the perfect sound"]}
              deletingSpeed={50}
              variableSpeed={{ min: 10, max: 70 }}
              cursorBlinkDuration={0.5}
            />
            <div className="row">
              <img src="/STANZA_W_TP.png" />
            </div>
            <form className="row" onSubmit={e => { e.preventDefault(); enter(); }}>
              <input
                id="greet-input"
                onChange={e => (nameRef.current = e.currentTarget.value)}
                placeholder="Enter your Username..."
              />
              <button type="submit">Enter</button>
            </form>
            <p>{}</p>
          </main>
        </>
      )}

      {/* ── MAIN ── */}
      {view === "main" && (
        <>
          <button onClick={handleToggle} style={{ position: 'fixed', top: 20, right: 20, zIndex: 1 }}>^</button>
          <main className="container" style={{ padding: "5vh 0.5vw 0vh 0.5vw" }}>
            <div>
              {/* Pass settings flags and lifted pedal state into MagicBento */}
              <MagicBento
                textAutoHide={true}
                enableStars={settings.particles}
                enableSpotlight={true}
                enableBorderGlow={true}
                enableTilt={false}
                enableMagnetism={false}
                clickEffect={true}
                spotlightRadius={500}
                particleCount={12}
                glowColor="132, 0, 255"
                disableAnimations={!settings.animations}
                theme={theme}
                pedalStates={pedalStates}
                onPedalStatesChange={setPedalStates}
                onPresetSaved={handlePresetSaved}
              />

              <div style={{ scale: "90%", top: '16vh', right: '80px', position: 'absolute', zIndex: -1 }}>
                <ModelViewer
                  url="https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/ToyCar/glTF-Binary/ToyCar.glb"
                  width={"15vw"} height={"15vh"}
                  modelXOffset={0} modelYOffset={0}
                  enableMouseParallax enableHoverRotation
                  environmentPreset="forest"
                  fadeIn={true} autoRotate={true} autoRotateSpeed={0.35}
                  showScreenshotButton={false}
                />
              </div>

              <img
                className="logoMain"
                style={{ scale: "25%", top: '-18vh', right: '17%', position: 'absolute', zIndex: 1 }}
                src={theme === 'dark' ? "/STANZA_B_TP.png" : "/STANZA_W_TP.png"}
              />

              <CircularText
                text={greetMsgRef.current}
                onHover="speedUp"
                spinDuration={20}
                className={theme === "dark" ? "custom-class" : "custom-class-light"}
              />
            </div>
          </main>
        </>
      )}

      {/* ── BOARD ── */}
      {view === "board" && (
        <main>
          <ModelViewer
            url="https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/ToyCar/glTF-Binary/ToyCar.glb"
            width={"100vw"} height={"100vh"}
            modelXOffset={0} modelYOffset={0}
            enableMouseParallax enableHoverRotation
            environmentPreset="forest"
            fadeIn={false} autoRotate={true} autoRotateSpeed={0.35}
            showScreenshotButton
          />
        </main>
      )}

      {/* ── PROFILE ── */}
      {view === "profile" && (
        <main>
          <Profile
            username={username}
            onUsernameChange={name => {
              setUsername(name);
              greetMsgRef.current = `${name}*STANZA*`;
            }}
            pedalStates={pedalStates}
            presetCount={presetSavedCount}
            sessionCount={sessionCount}
          />
        </main>
      )}

      {/* ── SETTINGS ── */}
      {view === "settings" && (
        <main>
          <Settings
            theme={theme}
            onThemeChange={handleThemeChange}
            username={username}
            settings={settings}
            onSettingsChange={handleSettingsChange}
          />
        </main>
      )}

      {/* ── Dock — magnification driven by Settings slider ── */}
      {showDock && (
        <Dock
          items={items}
          panelHeight={68}
          baseItemSize={50}
          magnification={settings.dockMag}
          theme={theme}
        />
      )}
    </>
  );
}

export default App;