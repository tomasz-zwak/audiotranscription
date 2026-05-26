import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  renameSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";

// ─── Paths ────────────────────────────────────────────────────────────────────

// app.getAppPath() = ui/electron/ (where package.json is) — works regardless of
// how Bun resolves __dirname in the bundled CJS output.
const APP_DIR = app.getAppPath();
const DIST_DIR = path.join(APP_DIR, "dist");
const PROJECT_ROOT = path.resolve(APP_DIR, "../..");
const RECORDINGS_DIR = path.join(PROJECT_ROOT, "recordings");
const SETTINGS_PATH = path.join(PROJECT_ROOT, "settings.json");
const SYSTEM_AUDIO_SRC = path.join(PROJECT_ROOT, "src", "system-audio", "capture.swift");
const SYSTEM_AUDIO_BIN = path.join(PROJECT_ROOT, "src", "system-audio", "capture");
const WHISPER_DIR = path.join(PROJECT_ROOT, "node_modules", "whisper-node", "lib", "whisper.cpp");
const WHISPER_BIN = path.join(WHISPER_DIR, "main");
const WHISPER_MODEL = path.join(WHISPER_DIR, "models", "ggml-base.en.bin");

// ─── Types ────────────────────────────────────────────────────────────────────

interface AudioDevice {
  index: number;
  name: string;
}

interface Settings {
  engine: "whisper-cpp" | "lumen-whisper";
  micDeviceIndex: number | null;
  micDeviceName: string | null;
}

interface Note {
  recordingOffset: string;
  wallTime: string;
  text: string;
}

interface Segment {
  start: string;
  end: string;
  speech: string;
  source?: "mic" | "sys";
}

interface ActiveRecording {
  micProc: ChildProcess;
  sysProc: ChildProcess | null;
  micTmpPath: string;
  micPath: string;
  sysTmpPath: string | null;
  sysPath: string | null;
  baseName: string;
  tickInterval: ReturnType<typeof setInterval> | null;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const SETTINGS_DEFAULTS: Settings = {
  engine: "whisper-cpp",
  micDeviceIndex: null,
  micDeviceName: null,
};

async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    return { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await loadSettings();
  await writeFile(SETTINGS_PATH, JSON.stringify({ ...current, ...patch }, null, 2));
}

// ─── Audio devices ────────────────────────────────────────────────────────────

function parseAudioDevices(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  let inAudioSection = false;
  for (const line of output.split("\n")) {
    if (line.includes("AVFoundation audio devices")) { inAudioSection = true; continue; }
    if (!inAudioSection) continue;
    const match = line.match(/\[(\d+)\]\s+(.+)/);
    if (match) devices.push({ index: parseInt(match[1], 10), name: match[2].trim() });
  }
  return devices;
}

function listAudioDevices(): Promise<AudioDevice[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", "null"]);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("close", () => resolve(parseAudioDevices(stderr)));
    proc.on("error", (err: NodeJS.ErrnoException) => {
      reject(new Error(
        err.code === "ENOENT"
          ? "ffmpeg not found — install it with: brew install ffmpeg"
          : err.message
      ));
    });
  });
}

// ─── System audio capture ─────────────────────────────────────────────────────

async function buildSystemAudioCapture(): Promise<void> {
  if (!existsSync(SYSTEM_AUDIO_SRC)) return;
  if (existsSync(SYSTEM_AUDIO_BIN)) {
    if (statSync(SYSTEM_AUDIO_BIN).mtimeMs >= statSync(SYSTEM_AUDIO_SRC).mtimeMs) return;
  }
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("swiftc", [
      "-framework", "ScreenCaptureKit",
      "-framework", "AVFoundation",
      "-framework", "CoreAudio",
      SYSTEM_AUDIO_SRC, "-o", SYSTEM_AUDIO_BIN,
    ]);
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`swiftc failed:\n${stderr}`)));
    proc.on("error", reject);
  });
}

function startSystemAudioCapture(outputPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn(SYSTEM_AUDIO_BIN, [outputPath], { stdio: ["ignore", "pipe", "ignore"] });
    let resolved = false;

    proc.stdout.on("data", (chunk: Buffer) => {
      if (!resolved && chunk.toString().includes("ready")) {
        resolved = true;
        // Stop reading stdout — we only needed the "ready" signal.
        // Unref the stream so it doesn't keep buffering and block the process.
        proc.stdout.destroy();
        resolve(proc);
      }
    });

    proc.on("close", (code) => {
      if (!resolved) reject(new Error(`System audio capture exited before ready (code ${code})`));
    });

    proc.on("error", (err) => { if (!resolved) reject(err); });

    setTimeout(() => {
      if (!resolved) { proc.kill(); reject(new Error("System audio capture timed out")); }
    }, 30_000);
  });
}

// ─── Recording ────────────────────────────────────────────────────────────────

let activeRecording: ActiveRecording | null = null;

async function startDualRecording(
  deviceIndex: number,
  win: BrowserWindow
): Promise<{ baseName: string; hasSystemAudio: boolean }> {
  if (activeRecording) throw new Error("A recording is already in progress");

  mkdirSync(RECORDINGS_DIR, { recursive: true });

  const baseName = `recording-${Date.now()}`;
  const base = path.join(RECORDINGS_DIR, baseName);
  const micTmpPath = `${base}-mic-tmp.wav`;
  const micPath = `${base}-mic.wav`;
  const sysTmpPath = `${base}-sys-tmp.wav`;
  const sysPath = `${base}-sys.wav`;

  // pipe stdin so we can send "q" for graceful stop; ignore stdout/stderr to
  // prevent the pipe buffer from filling and blocking ffmpeg mid-recording.
  const micProc = spawn("ffmpeg", [
    "-f", "avfoundation", "-i", `:${deviceIndex}`,
    "-ar", "16000", "-ac", "1", "-y", micTmpPath,
  ], { stdio: ["pipe", "ignore", "ignore"] });

  let sysProc: ChildProcess | null = null;
  let hasSystemAudio = false;

  try {
    if (existsSync(SYSTEM_AUDIO_BIN)) {
      sysProc = await startSystemAudioCapture(sysTmpPath);
      hasSystemAudio = true;
    }
  } catch {
    sysProc = null;
  }

  const startTime = Date.now();
  const tickInterval = setInterval(() => {
    if (!win.isDestroyed()) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      win.webContents.send("recording:tick", elapsed);
    }
  }, 500);

  activeRecording = {
    micProc,
    sysProc,
    micTmpPath,
    micPath,
    sysTmpPath,
    sysPath: hasSystemAudio ? sysPath : null,
    baseName,
    tickInterval,
  };

  return { baseName, hasSystemAudio };
}

async function stopDualRecording(): Promise<{
  micPath: string;
  sysPath: string | null;
  baseName: string;
}> {
  if (!activeRecording) throw new Error("No active recording");

  const { micProc, sysProc, micTmpPath, micPath, sysTmpPath, sysPath, baseName, tickInterval } = activeRecording;

  if (tickInterval) clearInterval(tickInterval);
  activeRecording = null;

  await Promise.all([
    stopFfmpegProcess(micProc),
    sysProc ? stopSignalProcess(sysProc) : Promise.resolve(),
  ]);

  if (existsSync(micTmpPath)) renameSync(micTmpPath, micPath);
  if (sysTmpPath && sysPath && existsSync(sysTmpPath)) renameSync(sysTmpPath, sysPath);

  return { micPath, sysPath, baseName };
}

function stopFfmpegProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) { resolve(); return; }
    proc.stdin?.write("q\n");
    proc.stdin?.end();
    const sigterm = setTimeout(() => proc.kill("SIGTERM"), 3_000);
    const sigkill = setTimeout(() => proc.kill("SIGKILL"), 8_000);
    proc.once("close", () => { clearTimeout(sigterm); clearTimeout(sigkill); resolve(); });
  });
}

function stopSignalProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) { resolve(); return; }
    proc.kill("SIGTERM");
    const sigkill = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    proc.once("close", () => { clearTimeout(sigkill); resolve(); });
  });
}

// ─── Transcription helpers ────────────────────────────────────────────────────

function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
    stream.on("end", () => resolve(buf));
    stream.on("error", reject);
  });
}

function parseSegments(output: string): Segment[] {
  const lines = output.match(/\[[0-9:.]+\s-->\s[0-9:.]+\].*/g);
  if (!lines) return [];
  return lines
    .map((line) => {
      const [timestamp, speech] = line.split("]  ");
      if (!timestamp || speech === undefined) return null;
      const [start, end] = timestamp.substring(1).split(" --> ");
      return { start, end, speech: speech.replace(/\n/g, "").trim() };
    })
    .filter((s): s is Segment => s !== null && s.speech.length > 0);
}

function toMs(t: string): number {
  const [h, m, s] = t.split(":").map(Number);
  return ((h * 60 + m) * 60 + s) * 1000;
}

function mergeSegments(a: Segment[], b: Segment[]): Segment[] {
  return [...a, ...b].sort((x, y) => toMs(x.start) - toMs(y.start));
}

function segmentsToText(segments: Segment[]): string {
  const blocks: Array<{ source?: "mic" | "sys"; text: string }> = [];
  for (const seg of segments) {
    const last = blocks[blocks.length - 1];
    if (last && last.source === seg.source) {
      last.text += " " + seg.speech;
    } else {
      blocks.push({ source: seg.source, text: seg.speech });
    }
  }
  const hasSource = blocks.some((b) => b.source != null);
  if (hasSource) {
    return blocks
      .map((b) => `${b.source === "mic" ? "[Mic]" : "[System]"} ${b.text.trim()}`)
      .join("\n");
  }
  return blocks.map((b) => b.text.trim()).join(" ").trim();
}

async function spawnWhisper(filePath: string): Promise<Segment[]> {
  const proc = spawn(
    WHISPER_BIN,
    ["-m", WHISPER_MODEL, "-ml", "1", "-f", path.resolve(filePath)],
    { cwd: WHISPER_DIR }
  );
  const [stdout] = await Promise.all([
    collectStream(proc.stdout),
    new Promise((r) => proc.on("close", r)),
  ]);
  return parseSegments(stdout);
}

async function normalizeForWhisper(input: string, output: string): Promise<void> {
  const proc = spawn("ffmpeg", [
    "-y", "-i", input,
    "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", output,
  ], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg normalize failed (code ${code})`)));
    proc.on("error", reject);
  });
}

async function detectSpeechRanges(audioPath: string): Promise<Array<{ start: number; end: number }>> {
  const proc = spawn("ffmpeg", [
    "-i", audioPath,
    "-af", "silencedetect=n=-40dB:d=0.3",
    "-f", "null", "/dev/null",
  ]);
  const stderr = await collectStream(proc.stderr);
  await new Promise((r) => proc.on("close", r));

  const durationMatch = stderr.match(/Duration:\s*(\d+:\d+:[\d.]+)/);
  const totalMs = durationMatch ? toMs(durationMatch[1]) : null;

  const silenceStarts: number[] = [];
  const silenceEnds: number[] = [];
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start:\s*([\d.]+)/);
    if (s) silenceStarts.push(parseFloat(s[1]) * 1000);
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e) silenceEnds.push(parseFloat(e[1]) * 1000);
  }

  const speech: Array<{ start: number; end: number }> = [];
  let pos = 0;
  for (let i = 0; i < silenceStarts.length; i++) {
    if (silenceStarts[i] > pos) speech.push({ start: pos, end: silenceStarts[i] });
    pos = silenceEnds[i] ?? totalMs ?? Infinity;
  }
  if (totalMs !== null && pos < totalMs) speech.push({ start: pos, end: totalMs });
  return speech;
}

async function filterSilentSegments(segments: Segment[], audioPath: string): Promise<Segment[]> {
  const speech = await detectSpeechRanges(audioPath);
  if (speech.length === 0) return segments;
  return segments.filter((seg) => {
    const s = toMs(seg.start);
    const e = toMs(seg.end);
    return speech.some((r) => s < r.end && e > r.start);
  });
}

// ─── Transcription pipelines ──────────────────────────────────────────────────

async function runDualTranscription(
  micPath: string,
  sysPath: string,
  baseName: string,
  notes: Note[],
  win: BrowserWindow
): Promise<{ text: string; transcriptPath: string }> {
  const send = (msg: string) => {
    if (!win.isDestroyed()) win.webContents.send("transcription:progress", msg);
  };

  send("Normalizing system audio…");
  const sysNormPath = sysPath.replace(/\.wav$/, "-norm.wav");
  await normalizeForWhisper(sysPath, sysNormPath);

  send("Transcribing mic audio…");
  const rawMic = await spawnWhisper(micPath);

  send("Transcribing system audio…");
  const rawSys = await spawnWhisper(sysNormPath);
  try { await unlink(sysNormPath); } catch {}

  send("Filtering and merging…");
  const [micSegs, sysSegs] = await Promise.all([
    filterSilentSegments(rawMic, micPath).then((s) => s.map((seg) => ({ ...seg, source: "mic" as const }))),
    filterSilentSegments(rawSys, sysPath).then((s) => s.map((seg) => ({ ...seg, source: "sys" as const }))),
  ]);

  const segments = mergeSegments(micSegs, sysSegs);
  const text = segmentsToText(segments);
  const transcriptPath = path.join(RECORDINGS_DIR, `${baseName}.txt`);

  const writes: Promise<unknown>[] = [
    writeFile(transcriptPath, text),
    writeFile(path.join(RECORDINGS_DIR, `${baseName}.json`), JSON.stringify(segments)),
  ];

  if (notes.length > 0) {
    const noteRecords = notes.map((n) => ({
      start: n.recordingOffset,
      end: n.recordingOffset,
      text: n.text,
      wallTime: n.wallTime,
    }));
    writes.push(
      writeFile(
        path.join(RECORDINGS_DIR, `${baseName}.metadata.json`),
        JSON.stringify(noteRecords, null, 2)
      )
    );
  }

  await Promise.all(writes);
  return { text, transcriptPath };
}

async function runSingleTranscription(
  filePath: string,
  win: BrowserWindow
): Promise<{ text: string; transcriptPath: string }> {
  if (!win.isDestroyed()) win.webContents.send("transcription:progress", "Transcribing…");
  const segments = await spawnWhisper(filePath);
  const text = segmentsToText(segments);
  const transcriptPath = filePath.replace(/\.\w+$/, ".txt");
  await Promise.all([
    writeFile(transcriptPath, text),
    writeFile(filePath.replace(/\.\w+$/, ".json"), JSON.stringify(segments)),
  ]);
  return { text, transcriptPath };
}

// ─── Recordings listing & rename ─────────────────────────────────────────────

const AUDIO_EXTS = new Set([".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aiff", ".aac"]);

function listRecordingFiles(): Array<{ name: string; path: string; size: number }> {
  mkdirSync(RECORDINGS_DIR, { recursive: true });
  try {
    return readdirSync(RECORDINGS_DIR)
      .filter((name) => {
        if (!AUDIO_EXTS.has(path.extname(name).toLowerCase())) return false;
        // Exclude companion files produced by dual recording
        if (name.endsWith("-sys.wav") || name.endsWith("-norm.wav")) return false;
        return true;
      })
      .sort()
      .reverse()
      .map((name) => {
        const full = path.join(RECORDINGS_DIR, name);
        return { name, path: full, size: statSync(full).size };
      });
  } catch {
    return [];
  }
}

function renameRecordingFiles(oldBase: string, newBase: string): void {
  for (const suffix of ["-mic.wav", "-sys.wav", ".txt", ".json", ".metadata.json"]) {
    const src = path.join(RECORDINGS_DIR, `${oldBase}${suffix}`);
    const dst = path.join(RECORDINGS_DIR, `${newBase}${suffix}`);
    try { if (existsSync(src)) renameSync(src, dst); } catch {}
  }
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 540,
    minHeight: 500,
    title: "Audio Transcription",
    backgroundColor: "#0f0f0f",
    webPreferences: {
      preload: path.join(DIST_DIR, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(DIST_DIR, "renderer", "index.html"));
  return win;
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

function registerIpcHandlers(win: BrowserWindow): void {
  ipcMain.handle("devices:list", () => listAudioDevices());
  ipcMain.handle("settings:load", () => loadSettings());
  ipcMain.handle("settings:save", (_e, patch: Partial<Settings>) => saveSettings(patch));

  ipcMain.handle("recording:start", async (_e, deviceIndex: number) => {
    return startDualRecording(deviceIndex, win);
  });

  ipcMain.handle("recording:stop", async () => {
    return stopDualRecording();
  });

  ipcMain.handle("transcribe:dual", async (_e, micPath: string, sysPath: string, baseName: string, notes: Note[]) => {
    return runDualTranscription(micPath, sysPath, baseName, notes, win);
  });

  ipcMain.handle("transcribe:single", async (_e, filePath: string) => {
    return runSingleTranscription(filePath, win);
  });

  ipcMain.handle("dialog:open-audio-file", async () => {
    const result = await dialog.showOpenDialog(win, {
      title: "Select audio file",
      defaultPath: RECORDINGS_DIR,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "ogg", "flac", "aiff", "aac"] }],
      properties: ["openFile"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("recordings:list", () => listRecordingFiles());

  ipcMain.handle("recording:rename", (_e, oldBase: string, newBase: string) => {
    renameRecordingFiles(oldBase, newBase);
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  const win = createWindow();

  // Grant microphone access for waveform visualization in renderer
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return permission === "media";
  });

  registerIpcHandlers(win);
  buildSystemAudioCapture().catch(() => {}); // non-fatal

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (activeRecording) {
    const { micProc, sysProc, tickInterval } = activeRecording;
    if (tickInterval) clearInterval(tickInterval);
    micProc.kill("SIGTERM");
    if (sysProc) sysProc.kill("SIGTERM");
    activeRecording = null;
  }
  if (process.platform !== "darwin") app.quit();
});
