import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

import FloatingLines from './FloatingLines';
import { VscHome, VscArchive, VscAccount, VscSettingsGear } from "react-icons/vsc";
import Dock from './Dock';



function App() {
  const greetMsgRef = useRef("");
  const nameRef = useRef("");

  const [view, setView] = useState("landing"); // 👈 controls page

  const items = [
  { icon: <VscHome size={18} />, label: 'Home', onClick: () => setView("landing") },
  { icon: <VscArchive size={18} />, label: 'Board', onClick: () => alert('Archive!') },
  { icon: <VscAccount size={18} />, label: 'Profile', onClick: () => alert('Profile!') },
  { icon: <VscSettingsGear size={18} />, label: 'Settings', onClick: () => alert('Settings!') },
];

  async function enter() {
    greetMsgRef.current = await invoke("greet", { name: nameRef.current });

    // wait 2 seconds
    setTimeout(() => {
      setView("main");
    }, 1000);
  }

  return (
    <>
      {/* background always present */}
      <div style={{ width: '100%', height: '100%', position: 'absolute', zIndex: -1 }}>
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
          <p>{greetMsgRef.current}</p>
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