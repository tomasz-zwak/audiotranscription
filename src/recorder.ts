import path from "node:path";
import { rmSync } from "node:fs";
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
      proc.stdin.write("q\n");
      await proc.stdin.flush();
      await proc.exited;
    },
  };
}

export async function startDualRecording(
  micDeviceIndex: number,
  outputPath: string
): Promise<RecordingSession> {
  const base = outputPath.replace(/\.wav$/, "");
  const micPath = `${base}-mic-tmp.wav`;
  const sysPath = `${base}-sys-tmp.wav`;

  const [sysSession, micProc] = await Promise.all([
    startSystemAudioCapture(sysPath),
    spawnMicRecording(micDeviceIndex, micPath),
  ]);

  return {
    filePath: outputPath,
    async stop() {
      // Stop both captures in parallel
      await Promise.all([
        sysSession.stop(),
        (async () => {
          micProc.stdin.write("q\n");
          await micProc.stdin.flush();
          await micProc.exited;
        })(),
      ]);

      // Mix mic + system audio into the final output file
      await mixAudio(micPath, sysPath, outputPath);

      // Clean up temp files
      for (const tmp of [micPath, sysPath]) {
        try { rmSync(tmp); } catch { /* ignore */ }
      }
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
    { stderr: "pipe", stdout: "pipe", stdin: "pipe" }
  );
}

async function mixAudio(micPath: string, sysPath: string, outputPath: string): Promise<void> {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-i", micPath,
      "-i", sysPath,
      "-filter_complex", "amix=inputs=2:normalize=0",
      "-ar", "16000",
      "-ac", "1",
      "-y",
      outputPath,
    ],
    { stderr: "pipe", stdout: "pipe", stdin: "ignore" }
  );

  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    throw new Error(`Audio mix failed:\n${stderr}`);
  }
}
