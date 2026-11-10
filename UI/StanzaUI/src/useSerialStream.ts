/**
 * useSerialStream
 *
 * Single shared audio input for the whole app: the board over serial, or a
 * microphone / audio interface. Both arrive as the same `audio_chunk` events.
 * Connect / disconnect from DashboardAudio; every consumer that calls
 * useSerialStream() sees the same `connected` / `selectedPort` state and
 * receives the same `audio_chunk` events.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export const BAUD_RATE = 2000000; // must match Serial.begin() in the .ino

/** Sources are serial port names, or MIC_PREFIX + an input device name. */
export const MIC_PREFIX = 'mic:';
export const isMicSource = (source: string) => source.startsWith(MIC_PREFIX);
export const sourceName = (source: string) => (isMicSource(source) ? source.slice(MIC_PREFIX.length) : source);

export interface SerialStreamControls {
  ports: string[];
  /** Microphone / audio-interface inputs, the system default first. */
  mics: string[];
  selectedPort: string;
  setSelectedPort: (p: string) => void;
  connected: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  refreshPorts: () => Promise<void>;
}

// ── Shared module state ───────────────────────────────────────────────────────

type ChunkHandler = (samples: number[]) => void;

let sharedPorts: string[] = [];
let sharedMics: string[] = [];
let sharedSelectedPort = '';
let sharedConnected = false;
let chunkUnlisten: UnlistenFn | null = null;
let connecting: Promise<void> | null = null;

const stateListeners = new Set<() => void>();
const chunkHandlers = new Set<ChunkHandler>();

function notifyState() {
  stateListeners.forEach(fn => fn());
}

function fanOutChunk(samples: number[]) {
  chunkHandlers.forEach(fn => fn(samples));
}

async function ensureChunkListener() {
  if (chunkUnlisten) return;
  chunkUnlisten = await listen<number[]>('audio_chunk', (event) => {
    fanOutChunk(event.payload);
  });
}

async function sharedRefreshPorts() {
  const [ports, mics] = await Promise.all([
    invoke<string[]>('list_serial_ports').catch(e => {
      console.warn('[useSerialStream] list_serial_ports failed:', e);
      return sharedPorts;
    }),
    invoke<string[]>('list_audio_inputs').catch(e => {
      console.warn('[useSerialStream] list_audio_inputs failed:', e);
      return sharedMics;
    }),
  ]);
  sharedPorts = ports;
  sharedMics = mics;
  // Keep the choice while it is still there; otherwise prefer the board
  const sources = [...ports, ...mics.map(m => MIC_PREFIX + m)];
  if (!sources.includes(sharedSelectedPort) && !sharedConnected) {
    sharedSelectedPort = sources[0] ?? '';
  }
  notifyState();
}

async function sharedConnect() {
  if (!sharedSelectedPort) return;
  if (sharedConnected) {
    await ensureChunkListener();
    return;
  }
  if (connecting) {
    await connecting;
    return;
  }

  connecting = (async () => {
    await ensureChunkListener();
    if (isMicSource(sharedSelectedPort)) {
      await invoke('stream_audio_mic', { deviceName: sourceName(sharedSelectedPort) });
    } else {
      await invoke('stream_audio_serial', {
        portName: sharedSelectedPort,
        baudRate: BAUD_RATE,
      });
    }
    sharedConnected = true;
    notifyState();
  })();

  try {
    await connecting;
  } catch (e) {
    console.warn('[useSerialStream] could not open', sharedSelectedPort, e);
  } finally {
    connecting = null;
  }
}

function sharedDisconnect() {
  chunkUnlisten?.();
  chunkUnlisten = null;
  sharedConnected = false;
  notifyState();
  // Releases a microphone; the serial task keeps draining its port (reconnect is idempotent).
  invoke('stop_audio_input').catch(e => console.warn('[useSerialStream] stop_audio_input failed:', e));
}

function sharedSetSelectedPort(p: string) {
  sharedSelectedPort = p;
  notifyState();
}

/** Subscribe to audio chunks outside React (e.g. shared analysers). Returns an unsubscribe fn. */
export function addChunkHandler(fn: ChunkHandler): () => void {
  chunkHandlers.add(fn);
  if (sharedConnected) void ensureChunkListener();
  return () => { chunkHandlers.delete(fn); };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSerialStream(
  onChunk: (samples: number[]) => void,
): SerialStreamControls {
  const [, bump] = useState(0);
  const onChunkRef = useRef(onChunk);
  onChunkRef.current = onChunk;

  // Sync local render with shared state + register chunk handler
  useEffect(() => {
    const onState = () => bump(n => n + 1);
    stateListeners.add(onState);

    const handler: ChunkHandler = (samples) => onChunkRef.current(samples);
    chunkHandlers.add(handler);

    // If already connected when this consumer mounts, attach to the event bus
    if (sharedConnected) {
      void ensureChunkListener();
    }

    return () => {
      stateListeners.delete(onState);
      chunkHandlers.delete(handler);
    };
  }, []);

  // Discover ports once (safe to call from every mount)
  useEffect(() => {
    void sharedRefreshPorts();
  }, []);

  const refreshPorts = useCallback(async () => {
    await sharedRefreshPorts();
  }, []);

  const connect = useCallback(async () => {
    await sharedConnect();
  }, []);

  const disconnect = useCallback(() => {
    sharedDisconnect();
  }, []);

  const setSelectedPort = useCallback((p: string) => {
    sharedSetSelectedPort(p);
  }, []);

  return {
    ports: sharedPorts,
    mics: sharedMics,
    selectedPort: sharedSelectedPort,
    setSelectedPort,
    connected: sharedConnected,
    connect,
    disconnect,
    refreshPorts,
  };
}
