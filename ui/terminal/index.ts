import * as clack from "@clack/prompts";
import { mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { listAudioDevices } from "../../src/devices";
import { startDualRecording } from "../../src/recorder";
import { buildSystemAudioCapture } from "../../src/system-audio/index";
import { segmentsToText, mergeSegments, type Transcriber } from "../../src/transcribe";
import { whisperCppTranscriber } from "../../src/transcribers/whisper-cpp";
import { lumenWhisperTranscriber } from "../../src/transcribers/lumen-whisper";
import { loadSettings, saveSettings, type Settings, type Engine } from "../../src/settings";
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
  } else if (mode === "record") {
    await recordFlow(transcriber, settings);
  } else {
    await existingFlow(transcriber);
  }
}

// ─── record flow ────────────────────────────────────────────────────────────

async function recordFlow(transcriber: Transcriber, settings: Settings) {
  const micDeviceIndex = await resolveMicDevice(settings);

  const tempName = `recording-${Date.now()}`;
  mkdirSync(RECORDINGS_DIR, { recursive: true });
  const filePath = path.join(RECORDINGS_DIR, `${tempName}.wav`);

  const session = await startDualRecording(micDeviceIndex, filePath);

  clack.log.step("Recording started — press Enter to stop");

  const startTime = Date.now();
  const timer = setInterval(() => {
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    process.stdout.write(`\r  ● ${mm}:${ss}`);
  }, 500);

  await waitForEnter();
  clearInterval(timer);
  process.stdout.write("\n");

  const stopSpinner = clack.spinner();
  stopSpinner.start("Finalizing recording");
  await session.stop();
  stopSpinner.stop("Recording saved");

  await transcribeDualAndDisplay(session.micPath, session.sysPath, tempName, transcriber);
  await renameFlow(tempName);
}

// ─── existing file flow ──────────────────────────────────────────────────────

async function existingFlow(transcriber: Transcriber) {
  mkdirSync(RECORDINGS_DIR, { recursive: true });

  const filePath = await pickAudioFile(RECORDINGS_DIR);
  if (!filePath) { clack.outro("No file selected"); process.exit(0); }

  clack.log.step(`Selected: ${path.relative(process.cwd(), filePath)}`);
  await transcribeAndDisplay(filePath, transcriber);
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
      clack.outro(`Engine set to ${engine}`);
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
      clack.outro(`Microphone set to "${chosen.name}"`);
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

async function transcribeDualAndDisplay(
  micPath: string,
  sysPath: string,
  baseName: string,
  transcriber: Transcriber
) {
  const spinner = clack.spinner();
  spinner.start("Transcribing mic + system audio");

  const [micSegments, sysSegments] = await Promise.all([
    transcriber.transcribe(micPath),
    transcriber.transcribe(sysPath),
  ]);

  const segments = mergeSegments(micSegments, sysSegments);
  const text = segmentsToText(segments);
  const transcriptPath = path.join(RECORDINGS_DIR, `${baseName}.txt`);

  await Promise.all([
    Bun.write(transcriptPath, text),
    Bun.write(path.join(RECORDINGS_DIR, `${baseName}.json`), JSON.stringify(segments)),
  ]);

  spinner.stop(`Transcript saved → ${path.relative(process.cwd(), transcriptPath)}`);
  clack.note(text || "(no speech detected)", "Transcript");
}

async function transcribeAndDisplay(filePath: string, transcriber: Transcriber) {
  const spinner = clack.spinner();
  spinner.start("Transcribing");
  const segments = await transcriber.transcribe(filePath);
  const text = segmentsToText(segments);
  const transcriptPath = filePath.replace(/\.\w+$/, ".txt");

  await Promise.all([
    Bun.write(transcriptPath, text),
    Bun.write(filePath.replace(/\.\w+$/, ".json"), JSON.stringify(segments)),
  ]);

  spinner.stop(`Transcript saved → ${path.relative(process.cwd(), transcriptPath)}`);
  clack.note(text || "(no speech detected)", "Transcript");
}

function resolveTranscriber(engine: Engine): Transcriber {
  return engine === "lumen-whisper" ? lumenWhisperTranscriber : whisperCppTranscriber;
}

function settingsHint(s: Settings): string {
  const parts: string[] = [s.engine];
  if (s.micDeviceName) parts.push(s.micDeviceName);
  return parts.join(" · ");
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (key: Buffer) => {
      const code = key[0];
      if (code === 0x03) { // Ctrl+C
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        clack.outro("Cancelled");
        process.exit(0);
      }
      if (code === 0x0d || code === 0x0a) { // Enter
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve();
      }
    };

    process.stdin.on("data", onData);
  });
}
