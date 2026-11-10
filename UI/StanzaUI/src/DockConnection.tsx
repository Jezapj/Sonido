import type { ReactNode } from "react";
import { isMicSource, MIC_PREFIX, sourceName, useSerialStream } from "./useSerialStream";

type Theme = "light" | "dark";

export default function DockConnection({
  theme,
  children,
}: {
  theme: Theme;
  children: ReactNode;
}) {
  const light = theme === "light";
  const {
    ports,
    mics,
    selectedPort,
    setSelectedPort,
    connected,
    connect,
    disconnect,
    refreshPorts,
  } = useSerialStream(() => {});

  const shell = [
    "dock-conn",
    light ? "dock-conn--light" : "",
    connected ? "dock-conn--connected" : "",
  ].filter(Boolean).join(" ");
  const mic = isMicSource(selectedPort);
  const none = ports.length === 0 && mics.length === 0;
  const action = light ? "dock-conn-btn dock-conn-action is-light" : "dock-conn-btn dock-conn-action";

  return (
    <div className="dock-row">
      <div className="dock-side">
        <div className={shell}>
          {connected ? (
            <div className="dock-conn-status">
              <span className="dock-conn-dot" />
              <span title={sourceName(selectedPort)}>
                {mic ? "Mic" : "Connected"}: {sourceName(selectedPort)}
              </span>
            </div>
          ) : (
            <>
              <span className="dock-conn-label">{mic ? "MIC" : "COMM"}</span>
              <select
                value={selectedPort}
                onChange={e => setSelectedPort(e.target.value)}
                aria-label="Audio input: board serial port or microphone"
                title={sourceName(selectedPort)}
              >
                {none && <option value="">No inputs found</option>}
                {ports.length > 0 && (
                  <optgroup label="Stanza board">
                    {ports.map(p => <option key={p} value={p}>{p}</option>)}
                  </optgroup>
                )}
                {mics.length > 0 && (
                  <optgroup label="Microphone">
                    {mics.map(m => <option key={m} value={MIC_PREFIX + m}>{m}</option>)}
                  </optgroup>
                )}
              </select>
              <button
                type="button"
                className="dock-conn-btn"
                onClick={() => { void refreshPorts(); }}
                title="Refresh ports and microphones"
              >
                ↺
              </button>
            </>
          )}
        </div>
      </div>
      {children}
      <div className="dock-side">
        <button
          type="button"
          className={action}
          onClick={() => { if (connected) disconnect(); else void connect(); }}
          disabled={!connected && !selectedPort}
        >
          {connected ? "Disconnect" : "Connect"}
        </button>
      </div>
    </div>
  );
}
