import path from "node:path";

export interface Segment {
  start: string;
  end: string;
  speech: string;
  source?: "mic" | "sys";
}

export interface Transcriber {
  transcribe(filePath: string): Promise<Segment[]>;
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

// Whisper noise tokens: [BLANK_AUDIO], [MUSIC], [NOISE], [INAUDIBLE], [SILENCE].
// With -ml 1 these are emitted as individual sub-tokens that reconstruct to the
// full marker when concatenated. We scan for such runs and drop them.
const NOISE_RE = /^\[(BLANK_?AUDIO|MUSIC|NOISE|INAUDIBLE|SILENCE)\]$/i;

// Longest known noise token is [BLANK_AUDIO] = 13 chars.
const MAX_NOISE_LEN = 15;

export function filterNoise(segments: Segment[]): Segment[] {
  const result: Segment[] = [];
  let i = 0;
  while (i < segments.length) {
    let found = false;
    let combined = "";
    for (let j = i; j < segments.length; j++) {
      combined += segments[j].speech.replace(/\s+/g, "");
      if (!combined.startsWith("[")) break;
      if (combined.length > MAX_NOISE_LEN) break;
      if (NOISE_RE.test(combined)) {
        i = j + 1; // skip all segments that formed this noise run
        found = true;
        break;
      }
    }
    if (!found) {
      result.push(segments[i]);
      i++;
    }
  }
  return result;
}

export function segmentsToText(segments: Segment[]): string {
  // Group consecutive same-source segments into labelled blocks.
  const blocks: Array<{ source?: "mic" | "sys"; text: string }> = [];
  for (const seg of segments) {
    const last = blocks[blocks.length - 1];
    if (last && last.source === seg.source) {
      last.text += " " + seg.speech;
    } else {
      blocks.push({ source: seg.source, text: seg.speech });
    }
  }

  const hasSource = blocks.some((b) => b.source != null);

  if (hasSource) {
    return blocks
      .map((b) => `${b.source === "mic" ? "[Mic]" : "[System]"} ${b.text.trim()}`)
      .join("\n");
  }
  return blocks.map((b) => b.text.trim()).join(" ").trim();
}

export function mergeSegments(a: Segment[], b: Segment[]): Segment[] {
  const toMs = (t: string): number => {
    const [h, m, s] = t.split(":").map(Number);
    return ((h * 60 + m) * 60 + s) * 1000;
  };
  return [...a, ...b].sort((x, y) => toMs(x.start) - toMs(y.start));
}
