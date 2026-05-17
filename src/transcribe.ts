import path from "node:path";

export interface Segment {
  start: string;
  end: string;
  speech: string;
}

const WHISPER_DIR = path.join(
  import.meta.dir,
  "../node_modules/whisper-node/lib/whisper.cpp"
);
const MAIN_BIN = path.join(WHISPER_DIR, "main");
const MODEL = path.join(WHISPER_DIR, "models/ggml-base.en.bin");

export async function transcribe(filePath: string): Promise<Segment[]> {
  const proc = Bun.spawn(
    [MAIN_BIN, "-m", MODEL, "-ml", "1", "-f", path.resolve(filePath)],
    { cwd: WHISPER_DIR, stdout: "pipe", stderr: "pipe", stdin: "ignore" }
  );

  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  return parseSegments(stdout);
}

export function parseSegments(output: string): Segment[] {
  const lines = output.match(/\[[0-9:.]+\s-->\s[0-9:.]+\].*/g);
  if (!lines || lines.length === 0) return [];

  return lines
    .map((line) => {
      const [timestamp, speech] = line.split("]  ");
      if (!timestamp || speech === undefined) return null;
      const [start, end] = timestamp.substring(1).split(" --> ");
      return { start, end, speech: speech.replace(/\n/g, "").trim() };
    })
    .filter((s): s is Segment => s !== null && s.speech.length > 0);
}

export function segmentsToText(segments: Segment[]): string {
  return segments.map((s) => s.speech).join(" ").trim();
}
