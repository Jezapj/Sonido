import type { ReactNode } from "react";
import { useSerialStream } from "./useSerialStream";

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
  const action = light ? "dock-conn-btn dock-conn-action is-light" : "dock-conn-btn dock-conn-action";

  return (
    <div className="dock-row">
      <div className="dock-side">
        <div className={shell}>
          {connected ? (
            <div className="dock-conn-status">
              <span className="dock-conn-dot" />
              <span>Connected: {selectedPort}</span>
            </div>
          ) : (
            <>
              <span className="dock-conn-label">COMM</span>
              <select
                value={selectedPort}
                onChange={e => setSelectedPort(e.target.value)}
                aria-label="Serial port"
              >
                {ports.length === 0
                  ? <option value="">No ports found</option>
                  : ports.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <button
                type="button"
                className="dock-conn-btn"
                onClick={() => { void refreshPorts(); }}
                title="Refresh ports"
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
