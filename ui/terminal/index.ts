import * as clack from "@clack/prompts";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { listAudioDevices } from "../../src/devices";
import { startRecording } from "../../src/recorder";
import { transcribe, segmentsToText } from "../../src/transcribe";

export async function run() {
  clack.intro(" Audio Recorder ");

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

  const recordingsDir = path.join(import.meta.dir, "..", "..", "recordings");
  mkdirSync(recordingsDir, { recursive: true });

  const filePath = path.join(recordingsDir, `recording-${Date.now()}.wav`);
  const session = await startRecording(deviceIndex as number, filePath);

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
  stopSpinner.stop(`Saved → ${path.relative(process.cwd(), filePath)}`);

  const transcribeSpinner = clack.spinner();
  transcribeSpinner.start("Transcribing");
  const segments = await transcribe(filePath);
  const text = segmentsToText(segments);
  const transcriptPath = filePath.replace(/\.wav$/, ".txt");
  await Bun.write(transcriptPath, text);
  transcribeSpinner.stop(`Transcription saved → ${path.relative(process.cwd(), transcriptPath)}`);

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
