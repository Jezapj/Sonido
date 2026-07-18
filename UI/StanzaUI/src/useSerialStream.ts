/**
 * useSerialStream
 *
 * Single shared serial connection for the whole app.
 * Connect / disconnect from DashboardAudio; every consumer that calls
 * useSerialStream() sees the same `connected` / `selectedPort` state and
 * receives the same `audio_chunk` events.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export const BAUD_RATE = 2000000; // must match Serial.begin() in the .ino

export interface SerialStreamControls {
  ports: string[];
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
  try {
    const list = await invoke<string[]>('list_serial_ports');
    sharedPorts = list;
    if (sharedSelectedPort === '' && list.length > 0) {
      sharedSelectedPort = list[0];
    }
    notifyState();
  } catch (e) {
    console.warn('[useSerialStream] list_serial_ports failed:', e);
  }
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
    await invoke('stream_audio_serial', {
      portName: sharedSelectedPort,
      baudRate: BAUD_RATE,
    });
    sharedConnected = true;
    notifyState();
  })();

  try {
    await connecting;
  } finally {
    connecting = null;
  }
}

function sharedDisconnect() {
  chunkUnlisten?.();
  chunkUnlisten = null;
  sharedConnected = false;
  notifyState();
  // Rust stream task may keep running; reconnect is idempotent.
}

function sharedSetSelectedPort(p: string) {
  sharedSelectedPort = p;
  notifyState();
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
    selectedPort: sharedSelectedPort,
    setSelectedPort,
    connected: sharedConnected,
    connect,
    disconnect,
    refreshPorts,
  };
}
