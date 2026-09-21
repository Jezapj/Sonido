# 🎨 STANZA UI — Tauri + React + TypeScript

> The **STANZA** desktop & Android application for the Sonido guitar platform.  
> Built with Tauri 2, React 19, TypeScript, and Vite.

[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5.x-646CFF?logo=vite)](https://vitejs.dev/)

---

## 🛠️ Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **Node.js** | 18+ (LTS) | [nodejs.org](https://nodejs.org/) |
| **Rust** | Stable | [rustup.rs](https://rustup.rs/) |
| **Tauri Prereqs** | OS-specific | [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/) |
| **Android SDK/NDK** | For mobile builds | [Tauri Android Guide](https://tauri.app/start/prerequisites/#android) |

---

## 📦 One-Time Setup

```bash
cd UI/StanzaUI

# Core dependencies
npm install

# UI & Visualization
npm install react-icons three motion gsap
npm install three @react-three/fiber @react-three/drei ogl

# shadcn/ui (no CSS variables mode)
npx shadcn@latest init --no-css-variables
# npx shadcn@latest add @react-bits/ShapeGrid-TS-CSS  # optional, needs Tailwind

# Android (run once per machine)
npm run tauri android init
```

---

## 🚀 Development

### Desktop

```bash
npm run tauri dev
```

- **Dev Server:** `http://localhost:3001`
- **Window Title:** `STANZA`
- **Product ID:** `com.jezap.stanzaui`

### Android

```bash
npm run tauri android dev
```

---

## 🏗️ Production Build

```bash
# Type definitions for Three.js (required for build)
npm i --save-dev @types/three

# Build release bundles
npm run tauri build
```

Outputs:
- **Desktop:** `src-tauri/target/release/bundle/`
- **Android:** `src-tauri/gen/android/app/build/outputs/apk/`

---

## 📁 Project Structure

```
UI/StanzaUI/
├── src/
│   ├── components/        # React components
│   │   ├── Board/         # Pedal board view
│   │   ├── Dashboard/     # Home dashboard cards
│   │   ├── Looper/        # Looper overlay & controls
│   │   ├── PedalOverlay.tsx    # Pedal knob overlay (ID contract!)
│   │   └── ...
│   ├── hooks/
│   │   └── useSerialStream.ts  # Serial connection & audio fan-out
│   ├── pages/             # Route-level views
│   ├── styles/            # CSS modules / global styles
│   ├── types/             # TypeScript interfaces
│   ├── utils/             # Helpers (audio, storage, etc.)
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs         # Tauri commands, serial, DSP packets, looper
│   │   └── main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## ⚙️ Key Configuration Files

| File | Purpose |
|------|---------|
| `tauri.conf.json` | App metadata, window config, bundle settings |
| `vite.config.ts` | Vite plugins, dev server port (3001), path aliases |
| `src-tauri/Cargo.toml` | Rust dependencies (serialport, serde, etc.) |
| `src-tauri/src/lib.rs` | **Core backend:** Serial I/O, TYPE A/B packets, looper state machine |

---

## 🔧 Critical Contracts (Must Stay in Sync)

> **⚠️ Changing these requires updates in 3 places:**

| Contract | Files |
|----------|-------|
| **Pedal IDs, knob counts, param order** | `src/PedalOverlay.tsx` · `Interface/ESP32/I2SESP_V3/I2SESP_V3.ino` · `src-tauri/src/lib.rs` (`update_dsp_params`) |
| **Serial protocol (TYPE A/B)** | `src-tauri/src/lib.rs` · `Interface/ESP32/I2SESP_V3/` |
| **Looper sample rate** | `src/utils/looper.ts` · ESP32 firmware (47991 Hz) |

---

## 🎯 Common Tasks

### Add a New Pedal
1. Implement in `Interface/ESP32/I2SESP_V3/` (register in `pedal_registry`)
2. Add entry to `PEDAL_DEFS` in `src/PedalOverlay.tsx`
3. Update `update_dsp_params` in `src-tauri/src/lib.rs`
4. Test knob mapping on hardware

### Modify Serial Protocol
1. Update packet builders in `src-tauri/src/lib.rs`
2. Update parsers in `Interface/ESP32/I2SESP_V3/`
3. Verify checksum logic matches

### Adjust Audio Sample Rate
1. Change in `src/utils/audio.ts` (host)
2. Update ESP32 I2S config
3. Recalculate looper latency constants

---

## 🐛 Troubleshooting

| Issue | Fix |
|-------|-----|
| `npm run tauri dev` fails | Run `rustup update` & `cargo clean` in `src-tauri/` |
| Android build fails | Verify `ANDROID_HOME`, `NDK` paths; run `npm run tauri android init` again |
| Serial port not found | Check USB cable, ESP32 flashing, baud rate = **2000000** |
| Pedal knobs do nothing | Verify `PEDAL_DEFS` order matches ESP32 `pedal_registry` |
| Three.js types error | `npm i --save-dev @types/three` |

---

## 📚 Useful Commands

```bash
# Type check
npm run check        # or: npx tsc --noEmit

# Lint
npm run lint

# Format
npm run format       # or: npx prettier --write .

# Tauri CLI help
npx tauri --help

# Open Tauri devtools
# Cmd/Ctrl + Shift + I in running app
```

---

## 🔗 Related Documentation

| Doc | Description |
|-----|-------------|
| [Root README](../README.md) | Project overview, hardware, quick start |
| [OVERVIEW.md](../OVERVIEW.md) | Deep dive: architecture, signal path, protocol |
| [Tauri Docs](https://tauri.app/) | Framework reference |
| [shadcn/ui](https://ui.shadcn.com/) | Component library |

---

## 📝 Notes

- **Compact mode** (`data-compact` on `<html>`) targets 800×480 screens
- **Presets & songs** stored in `localStorage` (keys prefixed with `stanza:`)
- **Theme** persists via `localStorage.theme` + CSS custom properties
- **Motion reduction** respects `prefers-reduced-motion` media query