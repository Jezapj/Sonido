import { useRef, useState, useEffect } from "react";
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
import Settings from './Settings';
import TextType from './TextType';

type Theme = 'dark' | 'light';

function App() {
  const greetMsgRef = useRef("");
  const nameRef = useRef("");

  const [view, setView] = useState("landing");
  const [bgVariant, setBgVariant] = useState(0);
  const [username, setUsername] = useState("");
  const [theme, setTheme] = useState<Theme>('dark');

  // Apply theme to document root so CSS [data-theme] selectors fire
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Light-mode body background override
  // useEffect(() => {
  //   if (theme === 'light') {
  //     document.body.style.backgroundColor = 'rgba(255,255,255, 0.7)';
  //     document.body.style.color = '#1a0f2e';
  //   } else {
  //     document.body.style.backgroundColor = '';
  //     document.body.style.color = '';
  //   }
  // }, [theme]);

  const items = [
    { icon: <VscHome size={18} />,         label: 'Home',     onClick: () => navigate("main") },
    { icon: <VscArchive size={18} />,      label: 'Board',    onClick: () => navigate("board") },
    { icon: <VscAccount size={18} />,      label: 'Profile',  onClick: () => navigate("profile") },
    { icon: <VscSettingsGear size={18} />, label: 'Settings', onClick: () => navigate("settings") },
  ];

  function switchBg() {
    setBgVariant(prev => (prev === 0 ? 1 : 0));
  }

  async function enter() {
    greetMsgRef.current = await invoke("greet", { name: nameRef.current });
    setUsername(nameRef.current.toUpperCase());
    setTimeout(() => {
      setView("main");
      switchBg();
    }, 800);
  }

  function navigate(location: string) {
    setTimeout(() => {
      setView(location);
      if (location === "main" || location === "board") switchBg();
    }, 200);
  }

  // Call this function when a button is clicked
  const handleToggle = () => {
    invoke('toggle_fullscreen'); 
  };

  // Shared floating-lines background
  const floatingLinesBg = (
    <FloatingLines
      enabledWaves={["top", "middle", "bottom"]}
      lineCount={8}
      lineDistance={8}
      bendRadius={8}
      bendStrength={-2}
      interactive={true}
      parallax={true}
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
        {/* Background 1 — landing / main */}
        <div style={{
          position: 'absolute', width: '100%', height: '100%',
          opacity: bgVariant === 0 ? 1 : 1,
          transition: 'opacity 0.6s ease-in-out',
          pointerEvents: 'none'
        }}>
          {theme === "dark" ? floatingLinesBg: <div style={{ width: '100%', height: '100%', backgroundColor: 'rgb(200, 200, 200)' }} />}
        </div>

        {/* Background 2 — board / secondary */}
        <div style={{
          position: 'absolute', width: '100%', height: '100%',
          opacity: bgVariant === 1 ? 1 : 0.3,
          transition: 'opacity 0.6s ease-in-out',
          pointerEvents: 'none'
        }}>
          <ShapeGrid
            speed={0.5}
            squareSize={40}
            direction="diagonal"
            borderColor={theme === 'light' ? 'rgba(100,100,100,0.7)' : "rgba(255,255,255,0.3)"}
            hoverFillColor="#222"
            shape="square"
            hoverTrailAmount={0}
          />
          {floatingLinesBg}
        </div>
      </div>

      {/* ── LANDING ── */}
      {view === "landing" && (<>
        <button onClick={handleToggle} style={{ position: 'fixed', top: 20, right: 20, zIndex: 1 }}> Toggle Fullscreen</button>
        <main className="container">
          <TextType 
          // text={["Interactive Audio DSP"]}
          typingSpeed={75}
          pauseDuration={1500}
          showCursor
          cursorCharacter="_"
          text={["Interactive Audio DSP","Build the prefect sound."]}
          deletingSpeed={50}
          
          variableSpeedMin={60}
          variableSpeedMax={120}
          cursorBlinkDuration={0.5}
        />
          {/* <h1>Interactive Audio DSP</h1> */}
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
            <MagicBento
              textAutoHide={true}
              enableStars
              enableSpotlight={true}
              enableBorderGlow={true}
              enableTilt={false}
              enableMagnetism={false}
              clickEffect={true}
              spotlightRadius={500}
              particleCount={12}
              glowColor="132, 0, 255"
              disableAnimations={false}
              theme={theme}
            >
              <div style={{ backgroundColor: "white", color: "white" }}></div>
            </MagicBento>

            <div style={{ scale: "90%", top: '16vh', right: '80px', position: 'absolute', zIndex: -1 }}>
              <ModelViewer
                url="https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/ToyCar/glTF-Binary/ToyCar.glb"
                width={"15vw"}
                height={"15vh"}
                modelXOffset={0}
                modelYOffset={0}
                enableMouseParallax
                enableHoverRotation
                environmentPreset="forest"
                fadeIn={true}
                autoRotate={true}
                autoRotateSpeed={0.35}
                showScreenshotButton={false}
              />
            </div>

            <img className="logoMain" style={{ scale: "25%", top: '-18vh', right: '17%', position: 'absolute', zIndex: 1 }} src={(theme === 'dark' )?"/STANZA_B_TP.png":"/STANZA_W_TP.png"} />

            <CircularText
              text={greetMsgRef.current}
              onHover="speedUp"
              spinDuration={20}
              className={theme === "dark"? "custom-class": "custom-class-light"}
            />
          </div>
        </main>
        </>
      )}

      {/* ── BOARD ── */}
      {view === "board" && (
        <main>
          <div>
            <ModelViewer
              url="https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/ToyCar/glTF-Binary/ToyCar.glb"
              width={"100vw"}
              height={"100vh"}
              modelXOffset={0}
              modelYOffset={0}
              enableMouseParallax
              enableHoverRotation
              environmentPreset="forest"
              fadeIn={false}
              autoRotate={true}
              autoRotateSpeed={0.35}
              showScreenshotButton
            />
          </div>
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
          />
        </main>
      )}

      {/* ── SETTINGS ── */}
      {view === "settings" && (
        <main>
          <Settings
            theme={theme}
            onThemeChange={setTheme}
            username={username}
          />
        </main>
      )}

      {/* ── Dock (all views except landing) ── */}
      {showDock && (
        <Dock
          items={items}
          panelHeight={68}
          baseItemSize={50}
          magnification={200}
          theme={theme}
        />
      )}
    </>
  );
}

export default App;