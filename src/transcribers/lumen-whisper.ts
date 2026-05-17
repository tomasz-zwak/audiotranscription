import type { Transcriber, Segment } from "../transcribe";
import { whisper } from "@lumen-labs-dev/whisper-node";
import path from "node:path";

const MODEL_PATH = path.join(
  import.meta.dir,
  "../../node_modules/whisper-node/lib/whisper.cpp/models/ggml-base.en.bin"
);

export const lumenWhisperTranscriber: Transcriber = {
  async transcribe(filePath: string): Promise<Segment[]> {
    const segments = await whisper(filePath, {
      modelPath: MODEL_PATH,
      whisperOptions: { language: "auto" },
      diarization: {
        enabled: true,
      }
    });
    return (segments ?? []).map((s) => ({
      start: s.start,
      end: s.end,
      speech: s.speech,
    }));
  },
};
