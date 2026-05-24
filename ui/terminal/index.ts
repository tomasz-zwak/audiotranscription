import * as clack from "@clack/prompts";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { listAudioDevices } from "../../src/devices";
import { startDualRecording } from "../../src/recorder";
import { buildSystemAudioCapture } from "../../src/system-audio/index";
import { segmentsToText, mergeSegments, type Transcriber } from "../../src/transcribe";
import { whisperCppTranscriber } from "../../src/transcribers/whisper-cpp";
import { lumenWhisperTranscriber } from "../../src/transcribers/lumen-whisper";
import { pickAudioFile } from "./file-picker";

const RECORDINGS_DIR = path.join(import.meta.dir, "..", "..", "recordings");

export async function run() {
  clack.intro(" Audio Transcription ");

  // Compile the ScreenCaptureKit helper on first run (takes ~20s)
  const buildSpinner = clack.spinner();
  buildSpinner.start("Preparing system audio capture");
  try {
    await buildSystemAudioCapture();
    buildSpinner.stop("System audio capture ready");
  } catch (err) {
    buildSpinner.stop("System audio capture unavailable — mic only");
    clack.log.warn(String(err));
  }

  const mode = await clack.select({
    message: "What would you like to do?",
    options: [
      { value: "record", label: "Record now", hint: "capture audio and transcribe" },
      { value: "existing", label: "Transcribe existing file", hint: "pick an audio file" },
    ],
  });

  if (clack.isCancel(mode)) {
    clack.outro("Cancelled");
    process.exit(0);
  }

  const engine = await clack.select({
    message: "Transcription engine",
    options: [
      { value: "whisper-cpp", label: "whisper.cpp", hint: "direct Bun.spawn (default)" },
      { value: "lumen-whisper", label: "@lumen-labs-dev/whisper-node", hint: "via lumen bindings" },
    ],
  });

  if (clack.isCancel(engine)) {
    clack.outro("Cancelled");
    process.exit(0);
  }

  const transcriber: Transcriber =
    engine === "lumen-whisper" ? lumenWhisperTranscriber : whisperCppTranscriber;

  if (mode === "record") {
    await recordFlow(transcriber);
  } else {
    await existingFlow(transcriber);
  }
}

async function recordFlow(transcriber: Transcriber) {
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

  if (devices.length === 0) {
    spinner.stop("No audio input devices found");
    process.exit(1);
  }

  spinner.stop(`Found ${devices.length} audio device(s)`);

  const deviceIndex = await clack.select({
    message: "Select input device",
    options: devices.map((d) => ({ value: d.index, label: d.name })),
  });

  if (clack.isCancel(deviceIndex)) {
    clack.outro("Cancelled");
    process.exit(0);
  }

  const defaultName = `recording-${Date.now()}`;
  const recordingName = await clack.text({
    message: "Recording name",
    placeholder: defaultName,
    defaultValue: defaultName,
    validate: (v) => {
      if (/[/\\:*?"<>|]/.test(v ?? "")) return "Name contains invalid characters";
    },
  });

  if (clack.isCancel(recordingName)) {
    clack.outro("Cancelled");
    process.exit(0);
  }

  mkdirSync(RECORDINGS_DIR, { recursive: true });
  const safeName = (recordingName as string).trim().replace(/\s+/g, "-");
  const filePath = path.join(RECORDINGS_DIR, `${safeName}.wav`);
  const session = await startDualRecording(deviceIndex as number, filePath);

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
  stopSpinner.stop(`Saved → ${safeName}-mic.wav + ${safeName}-sys.wav`);

  await transcribeDualAndDisplay(session.micPath, session.sysPath, safeName, transcriber);
}

async function existingFlow(transcriber: Transcriber) {
  mkdirSync(RECORDINGS_DIR, { recursive: true });

  const filePath = await pickAudioFile(RECORDINGS_DIR);

  if (!filePath) {
    clack.outro("No file selected");
    process.exit(0);
  }

  clack.log.step(`Selected: ${path.relative(process.cwd(), filePath)}`);
  await transcribeAndDisplay(filePath, transcriber);
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
  const rawPath = path.join(RECORDINGS_DIR, `${baseName}.json`);

  await Promise.all([
    Bun.write(transcriptPath, text),
    Bun.write(rawPath, JSON.stringify(segments)),
  ]);

  spinner.stop(`Transcript saved → ${path.relative(process.cwd(), transcriptPath)}`);
  clack.note(text || "(no speech detected)", "Transcript");
  clack.outro("Done!");
}

async function transcribeAndDisplay(filePath: string, transcriber: Transcriber) {
  const spinner = clack.spinner();
  spinner.start("Transcribing");
  const segments = await transcriber.transcribe(filePath);
  const rawSegmentsPath = filePath.replace(/\.\w+$/, ".json");
  await Bun.write(rawSegmentsPath, JSON.stringify(segments));
  const text = segmentsToText(segments);
  const transcriptPath = filePath.replace(/\.\w+$/, ".txt");
  await Bun.write(transcriptPath, text);
  spinner.stop(`Transcript saved → ${path.relative(process.cwd(), transcriptPath)}`);

  clack.note(text || "(no speech detected)", "Transcript");
  clack.outro("Done!");
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
