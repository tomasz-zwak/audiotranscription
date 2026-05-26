import { renameSync, existsSync } from "node:fs";
import { startSystemAudioCapture } from "./system-audio/index";

export interface RecordingSession {
  filePath: string;
  stop(): Promise<void>;
}

export async function startRecording(
  deviceIndex: number,
  filePath: string
): Promise<RecordingSession> {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-f", "avfoundation",
      "-i", `:${deviceIndex}`,
      "-ar", "16000",
      "-ac", "1",
      "-y",
      filePath,
    ],
    { stderr: "pipe", stdout: "pipe", stdin: "pipe" }
  );

  return {
    filePath,
    async stop() {
      await stopFfmpeg(proc);
    },
  };
}

export interface DualRecordingSession {
  micPath: string;
  sysPath: string;
  stop(): Promise<void>;
}

export async function startDualRecording(
  micDeviceIndex: number,
  outputPath: string
): Promise<DualRecordingSession> {
  const base = outputPath.replace(/\.wav$/, "");
  const micPath = `${base}-mic.wav`;
  const sysPath = `${base}-sys.wav`;
  const micTmp = `${base}-mic-tmp.wav`;
  const sysTmp = `${base}-sys-tmp.wav`;

  const [sysSession, micProc] = await Promise.all([
    startSystemAudioCapture(sysTmp),
    spawnMicRecording(micDeviceIndex, micTmp),
  ]);

  return {
    micPath,
    sysPath,
    async stop() {
      await Promise.all([
        sysSession.stop(),
        stopFfmpeg(micProc),
      ]);
      if (existsSync(micTmp)) renameSync(micTmp, micPath);
      if (existsSync(sysTmp)) renameSync(sysTmp, sysPath);
    },
  };
}

function spawnMicRecording(deviceIndex: number, filePath: string) {
  return Bun.spawn(
    [
      "ffmpeg",
      "-f", "avfoundation",
      "-i", `:${deviceIndex}`,
      "-ar", "16000",
      "-ac", "1",
      "-y",
      filePath,
    ],
    { stderr: "pipe", stdout: "ignore", stdin: "ignore" }
  );
}

async function stopFfmpeg(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  proc.kill("SIGTERM");
  const timeout = setTimeout(() => proc.kill("SIGKILL"), 5_000);
  await proc.exited;
  clearTimeout(timeout);
}

