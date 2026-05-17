---
name: electron-ui-architecture
description: IPC channels, build approach, component mapping, and file structure for the audio transcription Electron app
metadata:
  type: project
---

# Electron UI Architecture — Audio Transcription

## Build approach
- Source files: `main.ts`, `preload.ts`, `renderer/app.ts`, `renderer/style.css`, `renderer/index.html`
- Compiled to: `dist/` via `bun build`
- Electron entry point: `dist/main.js` (`"main": "dist/main.js"` in package.json)
- Build commands (all from within `ui/electron`):
  - `bun run build:main` → `bun build main.ts --target=node --outfile=dist/main.js --external=electron`
  - `bun run build:preload` → same pattern for preload.ts
  - `bun run build:renderer` → `bun build renderer/app.ts --target=browser --outfile=dist/renderer/app.js` + cp HTML/CSS
  - `bun run start` → `bun run build && electron .`

## IPC channels
- `devices:list` — ipcMain.handle → calls listAudioDevices() (reimplemented with Node child_process), returns `AudioDevice[]`
- `recording:start` — ipcMain.handle(deviceIndex) → spawns ffmpeg, sets up tick interval, returns filePath string
- `recording:stop` — ipcMain.handle → writes `q\n` to ffmpeg stdin, clears interval, returns filePath
- `recording:tick` — ipcMain.push (webContents.send) → sends elapsed seconds (number) every 500ms while recording

## Terminal UI → Electron UI mapping
| Terminal               | Electron                            |
|------------------------|-------------------------------------|
| clack.intro()          | `<header>` pill with "Audio Recorder" |
| clack.spinner()        | `#state-loading` with CSS spinner   |
| clack.select()         | `#state-select` with `<select>` dropdown |
| Recording + timer      | `#state-recording` with large monospace timer + rec dot |
| Press Enter to stop    | "Stop Recording" button             |
| clack.spinner (stop)   | `#state-finalizing` spinner         |
| Saved path display     | `#state-done` with monospace path box |
| Ctrl+C cancel          | Handled by window close event       |

## App state machine (renderer)
States: `loading` → `select` → `recording` → `finalizing` → `done`
Error can occur from loading or recording start, shown in `#state-error` with Retry button.
"New Recording" from done state goes back to `select` (reuses already-loaded device list).

## Key implementation notes
- Main process reimplements `listAudioDevices` and `startRecording` using Node.js `child_process.spawn` (not Bun.spawn — Electron runs Node, not Bun)
- `recordings/` directory path: `path.resolve(__dirname, '..', '..', '..')` from `dist/main.js` → `ui/electron/dist` → `ui/electron` → `ui` → project root, then `+ "/recordings"`
- ffmpeg startup detection: 500ms timeout; if ffmpeg errors before timeout fires, the promise rejects
- Tick interval lives in main process, pushed via `win.webContents.send("recording:tick", elapsed)`
- `sandbox: false` is required in webPreferences for the preload script to use contextBridge with ipcRenderer

## Design
- Dark theme: `#0f0f0f` background, `#1a1a1a` surface, `#4ade80` accent (green), `#f87171` danger (red)
- Large monospace timer (64px) mirrors the terminal's `mm:ss` output
- Blinking red dot mirrors the terminal's `● mm:ss` indicator
- Minimal, no framework — plain TypeScript in renderer

**Why:** Project uses Bun but Electron embeds Node.js. All device/recorder logic must be reimplemented in main.ts using Node APIs.
**How to apply:** When extending features, add new ipcMain.handle channels in main.ts and expose them in preload.ts via contextBridge.
