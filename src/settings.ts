import path from "node:path";

const SETTINGS_PATH = path.join(import.meta.dir, "../settings.json");

export type Engine = "whisper-cpp" | "lumen-whisper";

export interface Settings {
  engine: Engine;
  micDeviceIndex: number | null;
  micDeviceName: string | null;
}

const DEFAULTS: Settings = {
  engine: "whisper-cpp",
  micDeviceIndex: null,
  micDeviceName: null,
};

export async function loadSettings(): Promise<Settings> {
  try {
    const json = await Bun.file(SETTINGS_PATH).json();
    return { ...DEFAULTS, ...json };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await loadSettings();
  await Bun.write(SETTINGS_PATH, JSON.stringify({ ...current, ...patch }, null, 2));
}
