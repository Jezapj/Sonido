import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

import FloatingLines from './FloatingLines';
import { VscHome, VscArchive, VscAccount, VscSettingsGear } from "react-icons/vsc";
import Dock from './Dock';
import ShapeGrid from './ShapeGrid';



function App() {
  const greetMsgRef = useRef("");
  const nameRef = useRef("");

  const [view, setView] = useState("landing"); // 👈 controls page
  const [bgVariant, setBgVariant] = useState(0);

  const items = [
  { icon: <VscHome size={18} />, label: 'Home', onClick: () => navHome() },
  { icon: <VscArchive size={18} />, label: 'Board', onClick: () => alert('Archive!') },
  { icon: <VscAccount size={18} />, label: 'Profile', onClick: () => alert('Profile!') },
  { icon: <VscSettingsGear size={18} />, label: 'Settings', onClick: () => alert('Settings!') },
];
  function switchBg() {
    setBgVariant(prev => (prev === 0 ? 1 : 0));
  }
  async function enter() {
    greetMsgRef.current = await invoke("greet", { name: nameRef.current });

    
    // This is navigation to a new page, im going to put a new background here
    setTimeout(() => {
      setView("main");
      switchBg();
    }, 800);
  }
  function navHome() {
    
    setTimeout(() => {
      setView("landing");
      switchBg();
    }, 800);

    
  }

  return (
    <>
      <div style={{ position: 'absolute', width: '100%', height: '100%', zIndex: -1 }}>
  
  {/* Background 1 */}
  <div
    style={{
      position: 'absolute',
      width: '100%',
      height: '100%',
      opacity: bgVariant === 0 ? 1 : 1,
      transition: 'opacity 0.6s ease-in-out',
      pointerEvents: 'none'
    }}
  >
    <FloatingLines 
      enabledWaves="middle,bottom,top"
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
  </div>

  {/* Background 2 */}
  <div
    style={{
      position: 'absolute',
      width: '100%',
      height: '100%',
      opacity: bgVariant === 1 ? 1 : 0,
      transition: 'opacity 0.6s ease-in-out',
      pointerEvents: 'none'
    }}
  >
    <ShapeGrid 
      speed={0.5}
      squareSize={40}
      direction="diagonal"
      borderColor="#2F293A"
      hoverFillColor="#222"
      shape="square"
      hoverTrailAmount={0}
    />

    <FloatingLines 
      enabledWaves="middle,bottom,top"
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
  </div>

</div>

      {/* -------- LANDING SCREEN -------- */}
      {view === "landing" && (
        <main className="container">
          <h1>Interactive Audio DSP</h1>

          <div className="row">
            <img src="/STANZA_W_TP.png"/>
          </div>

          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              enter();
            }}
          >
            <input
              id="greet-input"
              onChange={(e) => (nameRef.current = e.currentTarget.value)}
              placeholder="Enter your Username..."
            />
            <button type="submit">Enter</button>
          </form>

          <p>{}</p>
        </main>
      )}

      {/* -------- MAIN APP SCREEN -------- */}
      {view === "main" && (
        <main className="container">
          <h1>{greetMsgRef.current}</h1>
          <Dock 
            items={items}
            panelHeight={68}
            baseItemSize={50}
            magnification={200}
          />
        </main>
      )}
    </>
  );
}

export default App;