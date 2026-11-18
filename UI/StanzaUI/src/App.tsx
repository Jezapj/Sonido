import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

import FloatingLines from './FloatingLines';
import { VscHome, VscArchive, VscAccount, VscSettingsGear } from "react-icons/vsc";
import Dock from './Dock';
import DockConnection from './DockConnection';
import ShapeGrid from './ShapeGrid';
import MagicBento from './MagicBento';
import ModelViewer from './ModelViewer';
import CircularText from './CircularText';
import Profile from './Profile';
import Settings, { AppSettings } from './Settings';
import TextType from './TextType';
import type { PedalState } from './PedalOverlay';
import { enterProfile, initProfile, updateProfile, useProfileValue, type Theme } from './profileStore';
import TouchShell from './touch/TouchShell';

// ── Compact layout hook — activates at 800×480 and similar small screens ──────
// Detects via window dimensions and syncs a data-compact attribute to the root
// element. While it is on, the dashboard, dock and pages below are replaced by
// the touch layout (touch/TouchShell.tsx); the desktop view is untouched.

function useCompactLayout(): boolean {
  const [isCompact, setIsCompact] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= 820 && window.innerHeight <= 520
  );

  useEffect(() => {
    const check = () => setIsCompact(window.innerWidth <= 820 && window.innerHeight <= 520);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.compact = isCompact ? 'true' : 'false';
  }, [isCompact]);

  return isCompact;
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const [view,      setView]      = useState("landing");
  const [bgVariant, setBgVariant] = useState(0);

  // ── Profile — the name, theme and settings all live in the loaded profile ───
  const username = useProfileValue(p => p.name);
  const theme    = useProfileValue(p => p.theme);
  const settings = useProfileValue(p => p.settings);
  const [nameDraft,  setNameDraft]  = useState("");
  const [entryError, setEntryError] = useState("");

  useEffect(() => { void initProfile(); }, []);
  useEffect(() => { setNameDraft(username); }, [username]);

  // ── Compact layout detection ──────────────────────────────────────────────
  const isCompact = useCompactLayout();

  const handleSettingsChange = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      updateProfile(p => ({ settings: { ...p.settings, [key]: value } }));
    },
    [],
  );

  // ── Pedal state — lifted so Profile can read it ───────────────────────────
  const [pedalStates, setPedalStates] = useState<Record<string, PedalState>>({});

  const handlePresetSaved = useCallback(() => {
    updateProfile(p => ({ presetsSaved: p.presetsSaved + 1 }));
  }, []);

  // Apply theme attribute so CSS [data-theme] selectors fire globally
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const handleThemeChange = useCallback((t: Theme) => {
    updateProfile({ theme: t });
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
    setEntryError("");
    try {
      await enterProfile(nameDraft);
    } catch (e) {
      setEntryError(`Couldn't open that profile: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
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
  const useDots = settings.bgPattern === 'dots';

  // ── Shared floating-lines background ─────────────────────────────────────
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

  const showDock = view !== "landing" && !isCompact;

  return (
    <>
      {/* ── Global background ── */}
      <div style={{ position: 'absolute', width: '100%', height: '100%', zIndex: -1 }}>
        {useDots ? (
          <>
            {/* Dark mode: floating lines under a translucent dots wash */}
            {theme === 'dark' && (
              <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                {floatingLinesBg}
              </div>
            )}
            <div
              className={`bg-dots ${theme === 'light' ? 'bg-dots--light' : 'bg-dots--dark'}`}
              style={{ width: '100%', height: '100%' }}
              aria-hidden
            />
          </>
        ) : (
          <>
            {/* Base wash under the grid */}
            <div style={{
              position: 'absolute', inset: 0,
              background: theme === 'light' ? '#e8eaef' : undefined,
              pointerEvents: 'none',
            }}>
              {theme === 'dark' && floatingLinesBg}
            </div>
            <div style={{
              position: 'absolute', inset: 0,
              opacity: theme === 'dark' ? (bgVariant === 1 ? 1 : 0.35) : 1,
              transition: 'opacity 0.6s ease-in-out',
              pointerEvents: 'none',
            }}>
              <ShapeGrid
                speed={shapeGridSpeed}
                squareSize={40}
                direction="diagonal"
                borderColor={theme === 'light'
                  ? 'rgba(80, 85, 100, 0.35)'
                  : 'rgba(255,255,255,0.3)'}
                hoverFillColor={theme === 'light' ? 'rgba(0,0,0,0.06)' : '#222'}
                shape="square"
                hoverTrailAmount={0}
              />
              {theme === 'dark' && floatingLinesBg}
            </div>
          </>
        )}
      </div>

      {/* ── LANDING ── */}
      {view === "landing" && (
        <>
          <button className="landing-fullscreen" onClick={handleToggle} style={{ position: 'fixed', top: 20, right: 20, zIndex: 1 }}>
            Toggle Fullscreen
          </button>
          <main className="container landing">
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
                value={nameDraft}
                onChange={e => setNameDraft(e.currentTarget.value)}
                placeholder="Enter your Username..."
              />
              <button type="submit">Enter</button>
            </form>
            <p>{entryError}</p>
          </main>
        </>
      )}

      {/* ── SMALL TOUCHSCREEN — every view below, as one touch layout ── */}
      {isCompact && view !== "landing" && (
        <TouchShell
          theme={theme}
          onThemeChange={handleThemeChange}
          username={username}
          settings={settings}
          onSettingsChange={handleSettingsChange}
          pedalStates={pedalStates}
          onPedalStatesChange={setPedalStates}
          onPresetSaved={handlePresetSaved}
          onFullscreen={handleToggle}
        />
      )}

      {/* ── MAIN ── */}
      {!isCompact && view === "main" && (
        <>
          <button onClick={handleToggle} style={{ position: 'fixed', top: 20, right: 20, zIndex: 1 }}>^</button>
          <main className="container" style={{ padding: "5vh 0.5vw 0vh 0.5vw" }}>
            <div>
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

              {/* 3D model viewer */}
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

              {/* Logo */}
              <img
                className="logoMain"
                style={{ scale: "25%", top: '-18vh', right: '17%', position: 'absolute', zIndex: 1 }}
                src={theme === 'dark' ? "/STANZA_B_TP.png" : "/STANZA_W_TP.png"}
              />

              {/* Ring text */}
              <CircularText
                text={`${username}*STANZA*`}
                onHover="speedUp"
                spinDuration={20}
                className={theme === "dark" ? "custom-class" : "custom-class-light"}
              />
            </div>
          </main>
        </>
      )}

      {/* ── BOARD ── */}
      {!isCompact && view === "board" && (
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
      {!isCompact && view === "profile" && (
        <main>
          <Profile pedalStates={pedalStates} />
        </main>
      )}

      {/* ── SETTINGS ── */}
      {!isCompact && view === "settings" && (
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
        <DockConnection theme={theme}>
          <Dock
            items={items}
            panelHeight={68}
            baseItemSize={50}
            magnification={settings.dockMag}
            theme={theme}
          />
        </DockConnection>
      )}
    </>
  );
}

export default App;