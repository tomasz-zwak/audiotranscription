// ─── Types ────────────────────────────────────────────────────────────────────

interface AudioDevice {
  index: number;
  name: string;
}

interface ElectronAPI {
  listDevices(): Promise<AudioDevice[]>;
  startRecording(deviceIndex: number): Promise<string>;
  stopRecording(): Promise<string>;
  onTick(callback: (elapsedSeconds: number) => void): () => void;
}

// window.electronAPI is injected by preload.ts via contextBridge
declare const window: Window & { electronAPI: ElectronAPI };

// ─── App state ────────────────────────────────────────────────────────────────

type AppState =
  | "loading"
  | "error"
  | "select"
  | "recording"
  | "finalizing"
  | "done";

let currentState: AppState = "loading";
let unsubscribeTick: (() => void) | null = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const stateLoading    = $<HTMLElement>("state-loading");
const stateError      = $<HTMLElement>("state-error");
const stateSelect     = $<HTMLElement>("state-select");
const stateRecording  = $<HTMLElement>("state-recording");
const stateFinalizing = $<HTMLElement>("state-finalizing");
const stateDone       = $<HTMLElement>("state-done");

const errorMessage  = $<HTMLParagraphElement>("error-message");
const deviceSelect  = $<HTMLSelectElement>("device-select");
const timerEl       = $<HTMLDivElement>("timer");
const savedPathEl   = $<HTMLParagraphElement>("saved-path");

const btnRetry = $<HTMLButtonElement>("btn-retry");
const btnStart = $<HTMLButtonElement>("btn-start");
const btnStop  = $<HTMLButtonElement>("btn-stop");
const btnNew   = $<HTMLButtonElement>("btn-new");

// ─── State transitions ────────────────────────────────────────────────────────

const stateMap: Record<AppState, HTMLElement> = {
  loading:    stateLoading,
  error:      stateError,
  select:     stateSelect,
  recording:  stateRecording,
  finalizing: stateFinalizing,
  done:       stateDone,
};

function showState(next: AppState): void {
  currentState = next;
  for (const [name, el] of Object.entries(stateMap)) {
    el.classList.toggle("hidden", name !== next);
  }
}

// ─── Timer formatting ─────────────────────────────────────────────────────────

function formatTime(totalSeconds: number): string {
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// ─── Core flows ───────────────────────────────────────────────────────────────

async function loadDevices(): Promise<void> {
  showState("loading");

  let devices: AudioDevice[];

  try {
    devices = await window.electronAPI.listDevices();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showError(msg.includes("ffmpeg")
      ? "ffmpeg not found. Install it with:\nbrew install ffmpeg"
      : msg);
    return;
  }

  if (devices.length === 0) {
    showError("No audio input devices found.\nMake sure a microphone is connected.");
    return;
  }

  populateDeviceSelect(devices);
  showState("select");
}

function showError(message: string): void {
  errorMessage.textContent = message;
  showState("error");
}

function populateDeviceSelect(devices: AudioDevice[]): void {
  deviceSelect.innerHTML = "";
  for (const device of devices) {
    const option = document.createElement("option");
    option.value = String(device.index);
    option.textContent = device.name;
    deviceSelect.appendChild(option);
  }
}

async function startRecording(): Promise<void> {
  const deviceIndex = parseInt(deviceSelect.value, 10);
  if (isNaN(deviceIndex)) return;

  btnStart.disabled = true;

  try {
    await window.electronAPI.startRecording(deviceIndex);
  } catch (err) {
    btnStart.disabled = false;
    const msg = err instanceof Error ? err.message : String(err);
    showError(msg);
    return;
  }

  // Subscribe to timer ticks from main process
  unsubscribeTick = window.electronAPI.onTick((elapsed) => {
    timerEl.textContent = formatTime(elapsed);
  });

  timerEl.textContent = "00:00";
  showState("recording");
}

async function stopRecording(): Promise<void> {
  btnStop.disabled = true;

  // Unsubscribe from tick events
  if (unsubscribeTick) {
    unsubscribeTick();
    unsubscribeTick = null;
  }

  showState("finalizing");

  let filePath: string;

  try {
    filePath = await window.electronAPI.stopRecording();
  } catch (err) {
    btnStop.disabled = false;
    const msg = err instanceof Error ? err.message : String(err);
    showError(msg);
    return;
  }

  savedPathEl.textContent = filePath;
  showState("done");
}

function resetToSelect(): void {
  btnStart.disabled = false;
  btnStop.disabled = false;
  timerEl.textContent = "00:00";
  savedPathEl.textContent = "";
  showState("select");
}

// ─── Event listeners ──────────────────────────────────────────────────────────

btnRetry.addEventListener("click", () => void loadDevices());
btnStart.addEventListener("click", () => void startRecording());
btnStop.addEventListener("click", () => void stopRecording());
btnNew.addEventListener("click", resetToSelect);

// ─── Boot ─────────────────────────────────────────────────────────────────────

void loadDevices();
