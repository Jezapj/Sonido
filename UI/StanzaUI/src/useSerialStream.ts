/**
 * useSerialStream
 *
 * Manages a single shared serial connection shared across all consumers.
 * Multiple components can call `connect()` safely — only the first call
 * opens the port (stream_audio_serial is idempotent on the Rust side).
 * All components listen to the same global `audio_chunk` event bus.
 *
 * Usage:
 *   const { ports, selectedPort, setSelectedPort, connected,
 *           connect, disconnect, refreshPorts } = useSerialStream(onChunk);
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

export function useSerialStream(
  onChunk: (samples: number[]) => void,
): SerialStreamControls {
  const [ports, setPorts] = useState<string[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [connected, setConnected] = useState(false);

  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Keep a stable ref to the callback so the listener never needs
  // to be re-registered when the parent component re-renders.
  const onChunkRef = useRef(onChunk);
  onChunkRef.current = onChunk;

  const refreshPorts = useCallback(async () => {
    try {
      const list = await invoke<string[]>('list_serial_ports');
      setPorts(list);
      // Auto-select first port if nothing is selected yet.
      setSelectedPort(prev => (prev === '' && list.length > 0 ? list[0] : prev));
    } catch (e) {
      console.warn('[useSerialStream] list_serial_ports failed:', e);
    }
  }, []);

  // Discover ports on mount.
  useEffect(() => { refreshPorts(); }, [refreshPorts]);

  const connect = useCallback(async () => {
    if (!selectedPort) return;

    // Subscribe to audio events first so we don't miss the first chunk.
    unlistenRef.current?.();
    unlistenRef.current = await listen<number[]>('audio_chunk', (event) => {
      onChunkRef.current(event.payload);
    });

    // stream_audio_serial is idempotent — safe to call from multiple components.
    await invoke('stream_audio_serial', {
      portName: selectedPort,
      baudRate: BAUD_RATE,
    });

    setConnected(true);
  }, [selectedPort]);

  const disconnect = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    setConnected(false);
    // Note: the Rust task keeps running so other components still receive events.
    // A future `stop_serial_stream` command can be added when needed.
  }, []);

  // Unlisten on unmount.
  useEffect(() => () => { unlistenRef.current?.(); }, []);

  return {
    ports,
    selectedPort,
    setSelectedPort,
    connected,
    connect,
    disconnect,
    refreshPorts,
  };
}