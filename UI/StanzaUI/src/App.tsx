import { useRef, useState } from "react";
import reactLogo from "./assets/react.svg";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import FloatingLines from './FloatingLines';

function App() {
  const greetMsgRef = useRef("");
  const nameRef = useRef("");
  const [, forceUpdate] = useState(0); // used to trigger re-render

  async function greet() {
    greetMsgRef.current = await invoke("greet", { name: nameRef.current });
    forceUpdate(n => n + 1); // force UI update
  }

  return (
    <>
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

      <main className="container">
        <h1>Interactive Audio DSP</h1>

        <div className="row">
          <img src="/STANZA_W_TP.png"/>
        </div>

        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            greet();
          }}
        >
          <input
            id="greet-input"
            onChange={(e) => (nameRef.current = e.currentTarget.value)}
            placeholder="Enter your Username..."
          />
          <button type="submit">Enter</button>
        </form>

        <p>{greetMsgRef.current}</p>
      </main>
    </>
  );
}

export default App;