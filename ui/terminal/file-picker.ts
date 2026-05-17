import * as clack from "@clack/prompts";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aiff", ".aac"]);

function isAudio(name: string) {
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export async function pickAudioFile(startDir: string): Promise<string | null> {
  let currentDir = startDir;

  while (true) {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      clack.log.error(`Cannot read: ${currentDir}`);
      currentDir = path.dirname(currentDir);
      continue;
    }

    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));

    const files = entries
      .filter((e) => e.isFile() && isAudio(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    type Option = { value: string; label: string; hint?: string };
    const options: Option[] = [];

    const parent = path.dirname(currentDir);
    if (parent !== currentDir) {
      options.push({ value: "__up__", label: ".. (go up)", hint: path.basename(parent) });
    }

    for (const d of dirs) {
      options.push({ value: path.join(currentDir, d.name), label: `${d.name}/` });
    }

    for (const f of files) {
      const fullPath = path.join(currentDir, f.name);
      const size = (() => {
        try { return statSync(fullPath).size; } catch { return 0; }
      })();
      const hint = size > 0 ? `${(size / 1024 / 1024).toFixed(1)} MB` : undefined;
      options.push({ value: fullPath, label: f.name, hint });
    }

    if (options.length === 0) {
      clack.log.warn("No audio files or folders here.");
      if (parent === currentDir) return null;
      currentDir = parent;
      continue;
    }

    const selected = await clack.select({
      message: currentDir,
      options,
    });

    if (clack.isCancel(selected)) return null;

    if (selected === "__up__") {
      currentDir = parent;
      continue;
    }

    let stat;
    try { stat = statSync(selected as string); } catch { return null; }

    if (stat.isDirectory()) {
      currentDir = selected as string;
    } else {
      return selected as string;
    }
  }
}
