import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AudioDevice {
  index: number;
  name: string;
}

// ─── Audio device detection ───────────────────────────────────────────────────

function parseAudioDevices(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  let inAudioSection = false;

  for (const line of output.split("\n")) {
    if (line.includes("AVFoundation audio devices")) {
      inAudioSection = true;
      continue;
    }
    if (!inAudioSection) continue;

    const match = line.match(/\[(\d+)\]\s+(.+)/);
    if (match) {
      devices.push({ index: parseInt(match[1], 10), name: match[2].trim() });
    }
  }

  return devices;
}

function listAudioDevices(): Promise<AudioDevice[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-f", "avfoundation",
      "-list_devices", "true",
      "-i", "",
    ]);

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", () => {
      // ffmpeg exits with code 1 when listing devices — that is expected
      resolve(parseAudioDevices(stderr));
    });

    proc.on("error", (err: Error) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("ffmpeg not found — install it with: brew install ffmpeg"));
      } else {
        reject(err);
      }
    });
  });
}

// ─── Recording state ──────────────────────────────────────────────────────────

interface ActiveRecording {
  proc: ChildProcess;
  filePath: string;
  tickInterval: ReturnType<typeof setInterval> | null;
  startTime: number;
}

let activeRecording: ActiveRecording | null = null;

function startRecordingProcess(
  deviceIndex: number,
  filePath: string,
  win: BrowserWindow
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-f", "avfoundation",
      "-i", `:${deviceIndex}`,
      "-ar", "44100",
      "-ac", "1",
      "-y",
      filePath,
    ]);

    proc.on("error", (err: Error) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("ffmpeg not found — install it with: brew install ffmpeg"));
      } else {
        reject(err);
      }
    });

    // Give ffmpeg a moment to start and fail early if there's an issue.
    // We resolve after a brief delay if no error occurred, indicating recording
    // has started successfully.
    const startTimeout = setTimeout(() => {
      const startTime = Date.now();

      const tickInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (!win.isDestroyed()) {
          win.webContents.send("recording:tick", elapsed);
        }
      }, 500);

      activeRecording = { proc, filePath, tickInterval, startTime };
      resolve(filePath);
    }, 500);

    proc.on("close", (code) => {
      // If ffmpeg closes before our timeout, it errored on startup
      clearTimeout(startTimeout);
      if (activeRecording) {
        // Normal stop — already handled in recording:stop
        return;
      }
      reject(new Error(`ffmpeg exited early (code ${code})`));
    });
  });
}

function stopRecordingProcess(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!activeRecording) {
      reject(new Error("No active recording"));
      return;
    }

    const { proc, filePath, tickInterval } = activeRecording;

    if (tickInterval) clearInterval(tickInterval);
    activeRecording = null;

    proc.stdin?.write("q\n");

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
    }, 5000);

    proc.on("close", () => {
      clearTimeout(timeout);
      resolve(filePath);
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    minWidth: 480,
    minHeight: 380,
    title: "Audio Recorder",
    backgroundColor: "#0f0f0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  return win;
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

function registerIpcHandlers(win: BrowserWindow): void {
  // devices:list — enumerate AVFoundation audio devices via ffmpeg
  ipcMain.handle("devices:list", async () => {
    return listAudioDevices();
  });

  // recording:start — begin capturing audio from the chosen device
  ipcMain.handle("recording:start", async (_event, deviceIndex: number) => {
    if (activeRecording) {
      throw new Error("A recording is already in progress");
    }

    // __dirname in dist/main.js → ui/electron/dist
    // climb: dist → electron → ui → project-root
    const projectRoot = path.resolve(__dirname, "..", "..", "..");
    const dir = path.join(projectRoot, "recordings");
    mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `recording-${Date.now()}.wav`);
    return startRecordingProcess(deviceIndex, filePath, win);
  });

  // recording:stop — finalize and flush the current recording
  ipcMain.handle("recording:stop", async () => {
    return stopRecordingProcess();
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  const win = createWindow();
  registerIpcHandlers(win);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // Stop any in-progress recording before quitting
  if (activeRecording) {
    const { proc, tickInterval } = activeRecording;
    if (tickInterval) clearInterval(tickInterval);
    proc.stdin?.write("q\n");
    activeRecording = null;
  }
  if (process.platform !== "darwin") app.quit();
});
