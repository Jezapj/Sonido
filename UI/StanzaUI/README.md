# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

# Running

Make sure you have installed the prerequisites for your OS: https://tauri.app/start/prerequisites/, then run (once):
  cd StanzaUI
  npm install

  npm install react-icons
  npm install three
  npm install motion
  npm install gsap
  npm install three @react-three/fiber @react-three/drei
  
  npx shadcn@latest init --no-css-variables
  npx shadcn@latest add @react-bits/ShapeGrid-TS-CSS //may not work without tailwind
  
  npm run tauri android init

For Desktop development, run:
  npm run tauri dev

For Android development, run:
  npm run tauri android dev

Before build

npm i --save-dev @types/three
npm run tauri build

