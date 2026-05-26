import * as clack from "@clack/prompts";
import { mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { listAudioDevices } from "../../src/devices";
import { startDualRecording } from "../../src/recorder";
import { buildSystemAudioCapture } from "../../src/system-audio/index";
import { type Transcriber } from "../../src/transcribe";
import { type Note, msToOffset } from "../../src/notes";
import { loadSettings, saveSettings, type Settings, type Engine } from "../../src/settings";
import { resolveTranscriber, runDualTranscriptionPipeline, runSingleTranscriptionPipeline } from "../../src/pipeline";
import { pickAudioFile } from "./file-picker";

const RECORDINGS_DIR = path.join(import.meta.dir, "..", "..", "recordings");

export async function run() {
  clack.intro(" Audio Transcription ");

  const buildSpinner = clack.spinner();
  buildSpinner.start("Preparing system audio capture");
  try {
    await buildSystemAudioCapture();
    buildSpinner.stop("System audio capture ready");
  } catch (err) {
    buildSpinner.stop("System audio capture unavailable — mic only");
    clack.log.warn(String(err));
  }

  while (true) {
    const settings = await loadSettings();
    const transcriber = resolveTranscriber(settings.engine);

    const mode = await clack.select({
      message: "What would you like to do?",
      options: [
        { value: "record",   label: "Record now",              hint: "capture mic + system audio" },
        { value: "existing", label: "Transcribe existing file", hint: "pick an audio file" },
        { value: "settings", label: "Settings",                 hint: settingsHint(settings) },
      ],
    });

    if (clack.isCancel(mode)) { clack.outro("Cancelled"); process.exit(0); }

    if (mode === "settings") {
      await settingsFlow(settings);
      // loop back to main menu
    } else if (mode === "record") {
      await recordFlow(transcriber, settings);
    } else {
      await existingFlow(transcriber);
    }
  }
}

// ─── record flow ────────────────────────────────────────────────────────────

async function recordFlow(transcriber: Transcriber, settings: Settings) {
  const micDeviceIndex = await resolveMicDevice(settings);

  const tempName = `recording-${Date.now()}`;
  mkdirSync(RECORDINGS_DIR, { recursive: true });
  const filePath = path.join(RECORDINGS_DIR, `${tempName}.wav`);

  const session = await startDualRecording(micDeviceIndex, filePath);

  clack.log.step("Recording  ·  Enter to stop  ·  / for commands");

  const startTime = Date.now();
  const timerState = { paused: false };

  const timer = setInterval(() => {
    if (timerState.paused) return;
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    process.stdout.write(`\r  ● ${mm}:${ss}`);
  }, 500);

  const notes = await recordingLoop(startTime, timerState);
  clearInterval(timer);
  process.stdout.write("\n");

  const stopSpinner = clack.spinner();
  stopSpinner.start("Finalizing recording");
  await session.stop();
  stopSpinner.stop("Recording saved");

  await runDualAndDisplay(session.micPath, session.sysPath, tempName, transcriber, notes);
  await renameFlow(tempName);
}

// ─── existing file flow ──────────────────────────────────────────────────────

async function existingFlow(transcriber: Transcriber) {
  mkdirSync(RECORDINGS_DIR, { recursive: true });

  const filePath = await pickAudioFile(RECORDINGS_DIR);
  if (!filePath) { clack.outro("No file selected"); process.exit(0); }

  clack.log.step(`Selected: ${path.relative(process.cwd(), filePath)}`);
  await runSingleAndDisplay(filePath, transcriber);
  clack.outro("Done!");
}

// ─── settings flow ───────────────────────────────────────────────────────────

async function settingsFlow(settings: Settings) {
  const what = await clack.select({
    message: "What would you like to change?",
    options: [
      {
        value: "engine",
        label: "Transcription engine",
        hint: settings.engine,
      },
      {
        value: "device",
        label: "Microphone",
        hint: settings.micDeviceName ?? "not set",
      },
    ],
  });

  if (clack.isCancel(what)) { clack.outro("Cancelled"); process.exit(0); }

  if (what === "engine") {
    const engine = await clack.select({
      message: "Transcription engine",
      options: [
        { value: "whisper-cpp",    label: "whisper.cpp",                   hint: "default" },
        { value: "lumen-whisper",  label: "@lumen-labs-dev/whisper-node",   hint: "lumen bindings" },
      ],
      initialValue: settings.engine,
    });

    if (!clack.isCancel(engine)) {
      await saveSettings({ engine: engine as Engine });
      clack.log.success(`Engine set to ${engine}`);
    }
  } else {
    const spinner = clack.spinner();
    spinner.start("Detecting audio devices");
    const devices = await listAudioDevices().catch(() => []);
    spinner.stop(`Found ${devices.length} audio device(s)`);

    const deviceIndex = await clack.select({
      message: "Select microphone",
      options: devices.map((d) => ({ value: d.index, label: d.name })),
      initialValue: settings.micDeviceIndex ?? undefined,
    });

    if (!clack.isCancel(deviceIndex)) {
      const chosen = devices.find((d) => d.index === deviceIndex)!;
      await saveSettings({ micDeviceIndex: chosen.index, micDeviceName: chosen.name });
      clack.log.success(`Microphone set to "${chosen.name}"`);
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function resolveMicDevice(settings: Settings): Promise<number> {
  if (settings.micDeviceIndex !== null) return settings.micDeviceIndex;

  // First run — pick and save
  const spinner = clack.spinner();
  spinner.start("Detecting audio devices");
  let devices;
  try {
    devices = await listAudioDevices();
  } catch {
    spinner.stop("Failed to run ffmpeg");
    clack.log.error("Make sure ffmpeg is installed: brew install ffmpeg");
    process.exit(1);
  }

  if (devices.length === 0) { spinner.stop("No audio input devices found"); process.exit(1); }
  spinner.stop(`Found ${devices.length} audio device(s)`);

  const deviceIndex = await clack.select({
    message: "Select microphone (saved for future sessions)",
    options: devices.map((d) => ({ value: d.index, label: d.name })),
  });

  if (clack.isCancel(deviceIndex)) { clack.outro("Cancelled"); process.exit(0); }

  const chosen = devices.find((d) => d.index === deviceIndex)!;
  await saveSettings({ micDeviceIndex: chosen.index, micDeviceName: chosen.name });
  clack.log.success(`Microphone saved: "${chosen.name}"`);
  return chosen.index;
}

async function renameFlow(currentName: string) {
  const newName = await clack.text({
    message: "Save recording as",
    placeholder: currentName,
    defaultValue: currentName,
    validate: (v) => {
      if (/[/\\:*?"<>|]/.test(v ?? "")) return "Name contains invalid characters";
    },
  });

  if (clack.isCancel(newName)) { clack.outro("Done!"); return; }

  const safeName = (newName as string).trim().replace(/\s+/g, "-");
  if (safeName !== currentName) {
    for (const suffix of ["-mic.wav", "-sys.wav", ".txt", ".json"]) {
      try {
        renameSync(
          path.join(RECORDINGS_DIR, `${currentName}${suffix}`),
          path.join(RECORDINGS_DIR, `${safeName}${suffix}`)
        );
      } catch { /* file may not exist */ }
    }
    clack.outro(`Saved as "${safeName}"`);
  } else {
    clack.outro("Done!");
  }
}

async function runDualAndDisplay(
  micPath: string,
  sysPath: string,
  baseName: string,
  transcriber: Transcriber,
  notes: Note[] = []
) {
  const spinner = clack.spinner();
  spinner.start("Transcribing mic + system audio");
  const { text, transcriptPath } = await runDualTranscriptionPipeline(micPath, sysPath, baseName, RECORDINGS_DIR, transcriber, notes);
  spinner.stop(`Transcript saved → ${path.relative(process.cwd(), transcriptPath)}`);
  clack.note(text || "(no speech detected)", "Transcript");
}

async function runSingleAndDisplay(filePath: string, transcriber: Transcriber) {
  const spinner = clack.spinner();
  spinner.start("Transcribing");
  const { text, transcriptPath } = await runSingleTranscriptionPipeline(filePath, transcriber);
  spinner.stop(`Transcript saved → ${path.relative(process.cwd(), transcriptPath)}`);
  clack.note(text || "(no speech detected)", "Transcript");
}

function settingsHint(s: Settings): string {
  const parts: string[] = [s.engine];
  if (s.micDeviceName) parts.push(s.micDeviceName);
  return parts.join(" · ");
}

async function recordingLoop(
  startTime: number,
  timerState: { paused: boolean }
): Promise<Note[]> {
  const notes: Note[] = [];
  process.stdin.setRawMode(true);
  process.stdin.resume();

  while (true) {
    const key = await nextKeypress();
    const code = key[0];

    if (code === 0x03) { // Ctrl+C
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      clack.outro("Cancelled");
      process.exit(0);
    }

    if (code === 0x0d || code === 0x0a) { // Enter — stop
      process.stdin.setRawMode(false);
      process.stdin.pause();
      return notes;
    }

    if (code === 0x2f) { // '/' — command palette
      timerState.paused = true;
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\r\x1b[2K"); // clear timer line

      await commandPalette(startTime, notes);

      process.stdin.setRawMode(true);
      process.stdin.resume();
      timerState.paused = false;
    }
  }
}

async function commandPalette(startTime: number, notes: Note[]): Promise<void> {
  const cmd = await clack.select({
    message: "/",
    options: [
      { value: "note", label: "note", hint: "add a timestamped note" },
    ],
  });

  if (clack.isCancel(cmd)) return;

  const input = await clack.text({ message: "Note" });
  if (clack.isCancel(input) || !(input as string).trim()) return;

  const elapsed = Date.now() - startTime;
  notes.push({
    recordingOffset: msToOffset(elapsed),
    wallTime: new Date().toISOString(),
    text: (input as string).trim(),
  });

  clack.log.success("Note saved");
}

function nextKeypress(): Promise<Buffer> {
  return new Promise((resolve) => process.stdin.once("data", resolve));
}


