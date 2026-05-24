# Audio Transcription

Records microphone + system audio simultaneously and transcribes using Whisper.

## Requirements

- macOS 12.3+ (ScreenCaptureKit)
- [Bun](https://bun.sh)
- ffmpeg
- Xcode Command Line Tools (for `swiftc` and `make`)

## Setup

### 1. Install system dependencies

```bash
# Bun runtime
curl -fsSL https://bun.sh/install | bash

# ffmpeg (recording and audio mixing)
brew install ffmpeg

# Xcode CLI tools (swiftc + make)
xcode-select --install
```

### 2. Install JS dependencies

```bash
bun install
```

### 3. Build whisper.cpp

```bash
make -j$(sysctl -n hw.logicalcpu) -C node_modules/whisper-node/lib/whisper.cpp
```

### 4. Download the Whisper model

```bash
bash node_modules/whisper-node/lib/whisper.cpp/models/download-ggml-model.sh base.en
```

### 5. Link the Whisper binary for the lumen transcriber

```bash
ln -sf "$(pwd)/node_modules/whisper-node/lib/whisper.cpp/main" \
  node_modules/@lumen-labs-dev/whisper-node/lib/whisper.cpp/main
```

### 6. Compile the system audio capture helper

```bash
swiftc -framework ScreenCaptureKit -framework AVFoundation \
  src/system-audio/capture.swift -o src/system-audio/capture
```

> This step also runs automatically on the first `bun run index.ts`, but doing it upfront avoids a ~20 s wait.

## Permissions

On first run macOS will ask for two permissions:

- **Microphone** — prompted by ffmpeg when recording starts
- **Screen & System Audio Recording** — prompted by the system audio capture helper; if the prompt doesn't appear automatically, go to System Settings › Privacy & Security › Screen & System Audio Recording and enable access for your terminal

## Run

```bash
bun run index.ts
```
