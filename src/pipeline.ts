import path from "node:path";
import { filterSilentSegments, mergeSegments, segmentsToText, type Segment, type Transcriber } from "./transcribe";
import { type Note, noteToRecord } from "./notes";
import { whisperCppTranscriber } from "./transcribers/whisper-cpp";
import { lumenWhisperTranscriber } from "./transcribers/lumen-whisper";
import { type Engine } from "./settings";

export interface PipelineResult {
  text: string;
  transcriptPath: string;
  segments: Segment[];
}

export async function normalizeForWhisper(input: string, output: string): Promise<void> {
  const proc = Bun.spawn(
    ["ffmpeg", "-y", "-i", input, "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", output],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" }
  );
  await proc.exited;
}

export async function runDualTranscriptionPipeline(
  micPath: string,
  sysPath: string,
  baseName: string,
  recordingsDir: string,
  transcriber: Transcriber,
  notes: Note[] = []
): Promise<PipelineResult> {
  const sysNormPath = sysPath.replace(/\.wav$/, "-norm.wav");
  await normalizeForWhisper(sysPath, sysNormPath);

  const [rawMic, rawSys] = await Promise.all([
    transcriber.transcribe(micPath),
    transcriber.transcribe(sysNormPath),
  ]).finally(() => Bun.spawn(["rm", "-f", sysNormPath]));

  const [micSegments, sysSegments] = await Promise.all([
    filterSilentSegments(rawMic, micPath).then((s) => s.map((seg) => ({ ...seg, source: "mic" as const }))),
    filterSilentSegments(rawSys, sysPath).then((s) => s.map((seg) => ({ ...seg, source: "sys" as const }))),
  ]);

  const segments = mergeSegments(micSegments, sysSegments);
  const text = segmentsToText(segments);
  const transcriptPath = path.join(recordingsDir, `${baseName}.txt`);

  const writes: Promise<unknown>[] = [
    Bun.write(transcriptPath, text),
    Bun.write(path.join(recordingsDir, `${baseName}.json`), JSON.stringify(segments)),
  ];

  if (notes.length > 0) {
    writes.push(
      Bun.write(
        path.join(recordingsDir, `${baseName}.metadata.json`),
        JSON.stringify(notes.map(noteToRecord), null, 2)
      )
    );
  }

  await Promise.all(writes);
  return { text, transcriptPath, segments };
}

export async function runSingleTranscriptionPipeline(
  filePath: string,
  transcriber: Transcriber
): Promise<PipelineResult> {
  const segments = await transcriber.transcribe(filePath);
  const text = segmentsToText(segments);
  const transcriptPath = filePath.replace(/\.\w+$/, ".txt");

  await Promise.all([
    Bun.write(transcriptPath, text),
    Bun.write(filePath.replace(/\.\w+$/, ".json"), JSON.stringify(segments)),
  ]);

  return { text, transcriptPath, segments };
}

export function resolveTranscriber(engine: Engine): Transcriber {
  return engine === "lumen-whisper" ? lumenWhisperTranscriber : whisperCppTranscriber;
}
