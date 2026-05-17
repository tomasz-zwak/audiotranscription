import { contextBridge, ipcRenderer } from "electron";

// ─── Types exposed to renderer ────────────────────────────────────────────────

export interface AudioDevice {
  index: number;
  name: string;
}

export interface ElectronAPI {
  /** List all AVFoundation audio input devices */
  listDevices(): Promise<AudioDevice[]>;

  /** Start recording from the specified device; resolves to the output file path */
  startRecording(deviceIndex: number): Promise<string>;

  /** Stop the current recording; resolves to the saved file path */
  stopRecording(): Promise<string>;

  /**
   * Subscribe to elapsed-time ticks while recording.
   * The callback receives the elapsed seconds as a number.
   * Returns an unsubscribe function.
   */
  onTick(callback: (elapsedSeconds: number) => void): () => void;
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

const api: ElectronAPI = {
  listDevices() {
    return ipcRenderer.invoke("devices:list");
  },

  startRecording(deviceIndex: number) {
    return ipcRenderer.invoke("recording:start", deviceIndex);
  },

  stopRecording() {
    return ipcRenderer.invoke("recording:stop");
  },

  onTick(callback: (elapsedSeconds: number) => void) {
    const handler = (_event: Electron.IpcRendererEvent, elapsed: number) => {
      callback(elapsed);
    };
    ipcRenderer.on("recording:tick", handler);

    // Return unsubscribe
    return () => {
      ipcRenderer.removeListener("recording:tick", handler);
    };
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);
