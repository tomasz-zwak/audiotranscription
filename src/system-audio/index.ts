import path from "node:path";
import { existsSync, statSync } from "node:fs";

const SWIFT_SRC = path.join(import.meta.dir, "capture.swift");
const BINARY = path.join(import.meta.dir, "capture");

export async function buildSystemAudioCapture(): Promise<void> {
  if (existsSync(BINARY) && statSync(BINARY).mtimeMs >= statSync(SWIFT_SRC).mtimeMs) return;

  const proc = Bun.spawn(
    [
      "swiftc",
      "-framework", "ScreenCaptureKit",
      "-framework", "AVFoundation",
      "-framework", "CoreAudio",
      SWIFT_SRC,
      "-o", BINARY,
    ],
    { stdout: "inherit", stderr: "pipe", stdin: "ignore" }
  );

  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    throw new Error(`Failed to compile system audio helper:\n${stderr}`);
  }
}

export async function startSystemAudioCapture(
  outputPath: string
): Promise<{ stop(): Promise<void> }> {
  const proc = Bun.spawn([BINARY, outputPath], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  await Promise.race([
    waitForReady(proc.stdout),
    proc.exited.then(() => {
      throw new Error("System audio capture exited before signalling ready");
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("System audio capture timed out waiting for permission")), 90_000)
    ),
  ]);

  return {
    async stop(): Promise<void> {
      proc.kill("SIGTERM");
      // Give it 5 s to flush and exit cleanly, then force-kill
      const timeout = setTimeout(() => proc.kill("SIGKILL"), 5_000);
      await proc.exited;
      clearTimeout(timeout);
    },
  };
}

async function waitForReady(stdout: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Stream ended before ready signal");
      if (decoder.decode(value).includes("ready")) return;
    }
  } finally {
    reader.releaseLock();
  }
}
