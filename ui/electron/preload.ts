import { contextBridge, ipcRenderer } from "electron";

// ─── Types exposed to renderer ────────────────────────────────────────────────

export interface AudioDevice {
  index: number;
  name: string;
}

export interface Settings {
  engine: "whisper-cpp" | "lumen-whisper";
  micDeviceIndex: number | null;
  micDeviceName: string | null;
}

export interface Note {
  recordingOffset: string;
  wallTime: string;
  text: string;
}

export interface RecordingFile {
  name: string;
  path: string;
  size: number;
}

export interface StartResult {
  baseName: string;
  hasSystemAudio: boolean;
}

export interface StopResult {
  micPath: string;
  sysPath: string | null;
  baseName: string;
}

export interface TranscriptResult {
  text: string;
  transcriptPath: string;
}

export interface ElectronAPI {
  listDevices(): Promise<AudioDevice[]>;
  loadSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  startRecording(deviceIndex: number): Promise<StartResult>;
  stopRecording(): Promise<StopResult>;
  transcribeDual(micPath: string, sysPath: string, baseName: string, notes: Note[]): Promise<TranscriptResult>;
  transcribeSingle(filePath: string): Promise<TranscriptResult>;
  openAudioFile(): Promise<string | null>;
  listRecordings(): Promise<RecordingFile[]>;
  renameRecording(oldBase: string, newBase: string): Promise<void>;
  onTick(callback: (elapsed: number) => void): () => void;
  onTranscriptionProgress(callback: (message: string) => void): () => void;
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

const api: ElectronAPI = {
  listDevices: () => ipcRenderer.invoke("devices:list"),
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  startRecording: (deviceIndex) => ipcRenderer.invoke("recording:start", deviceIndex),
  stopRecording: () => ipcRenderer.invoke("recording:stop"),
  transcribeDual: (micPath, sysPath, baseName, notes) =>
    ipcRenderer.invoke("transcribe:dual", micPath, sysPath, baseName, notes),
  transcribeSingle: (filePath) => ipcRenderer.invoke("transcribe:single", filePath),
  openAudioFile: () => ipcRenderer.invoke("dialog:open-audio-file"),
  listRecordings: () => ipcRenderer.invoke("recordings:list"),
  renameRecording: (oldBase, newBase) => ipcRenderer.invoke("recording:rename", oldBase, newBase),

  onTick(callback) {
    const handler = (_: Electron.IpcRendererEvent, elapsed: number) => callback(elapsed);
    ipcRenderer.on("recording:tick", handler);
    return () => ipcRenderer.removeListener("recording:tick", handler);
  },

  onTranscriptionProgress(callback) {
    const handler = (_: Electron.IpcRendererEvent, msg: string) => callback(msg);
    ipcRenderer.on("transcription:progress", handler);
    return () => ipcRenderer.removeListener("transcription:progress", handler);
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);
