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
