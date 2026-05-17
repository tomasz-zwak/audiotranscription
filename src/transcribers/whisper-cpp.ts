import type { Transcriber, Segment } from "../transcribe";
import { parseSegments } from "../transcribe";
import path from "node:path";

const WHISPER_DIR = path.join(
  import.meta.dir,
  "../../node_modules/whisper-node/lib/whisper.cpp"
);
const MAIN_BIN = path.join(WHISPER_DIR, "main");
const MODEL = path.join(WHISPER_DIR, "models/ggml-base.en.bin");

export const whisperCppTranscriber: Transcriber = {
  async transcribe(filePath: string): Promise<Segment[]> {
    const proc = Bun.spawn(
      [MAIN_BIN, "-m", MODEL, "-ml", "1", "-f", path.resolve(filePath)],
      { cwd: WHISPER_DIR, stdout: "pipe", stderr: "pipe", stdin: "ignore" }
    );
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return parseSegments(stdout);
  },
};
