// ─── Types ────────────────────────────────────────────────────────────────────

interface AudioDevice { index: number; name: string; }

interface Settings {
  engine: "whisper-cpp" | "lumen-whisper";
  micDeviceIndex: number | null;
  micDeviceName: string | null;
}

interface Note { recordingOffset: string; wallTime: string; text: string; }

interface RecordingFile { name: string; path: string; size: number; }

interface StartResult { baseName: string; hasSystemAudio: boolean; }

interface StopResult { micPath: string; sysPath: string | null; baseName: string; }

interface TranscriptResult { text: string; transcriptPath: string; }

interface ElectronAPI {
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

declare const window: Window & { electronAPI: ElectronAPI };

// ─── App state ────────────────────────────────────────────────────────────────

type AppState =
  | "loading"
  | "error"
  | "record-idle"
  | "device-select"
  | "recording"
  | "stopping"
  | "transcribing"
  | "done"
  | "files"
  | "settings";

let currentState: AppState = "loading";
let settings: Settings = { engine: "whisper-cpp", micDeviceIndex: null, micDeviceName: null };
let devices: AudioDevice[] = [];
let elapsedSeconds = 0;
let pendingNotes: Note[] = [];
let unsubTick: (() => void) | null = null;
let unsubProgress: (() => void) | null = null;
let doneBaseName = "";
let doneIsRecording = false;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const panels: Record<AppState, HTMLElement> = {
  loading:        $("state-loading"),
  error:          $("state-error"),
  "record-idle":  $("state-record-idle"),
  "device-select":$("state-device-select"),
  recording:      $("state-recording"),
  stopping:       $("state-stopping"),
  transcribing:   $("state-transcribing"),
  done:           $("state-done"),
  files:          $("state-files"),
  settings:       $("state-settings"),
};

const navItems: Record<string, HTMLButtonElement> = {
  record:   $<HTMLButtonElement>("nav-record"),
  files:    $<HTMLButtonElement>("nav-files"),
  settings: $<HTMLButtonElement>("nav-settings"),
};

const NAV_FOR_STATE: Partial<Record<AppState, string>> = {
  "record-idle":  "record",
  "device-select":"record",
  recording:      "record",
  stopping:       "record",
  transcribing:   "record",
  done:           "record",
  files:          "files",
  settings:       "settings",
};

// ─── State machine ────────────────────────────────────────────────────────────

function showState(next: AppState): void {
  currentState = next;
  for (const [name, el] of Object.entries(panels)) {
    el.classList.toggle("hidden", name !== next);
  }
  const activeNav = NAV_FOR_STATE[next];
  for (const [name, btn] of Object.entries(navItems)) {
    btn.classList.toggle("active", name === activeNav);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

const timeout = <T>(ms: number, fallback: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(fallback), ms));

async function boot(): Promise<void> {
  showState("loading");
  try {
    [settings, devices] = await Promise.all([
      Promise.race([
        window.electronAPI.loadSettings(),
        timeout(5000, { engine: "whisper-cpp", micDeviceIndex: null, micDeviceName: null } as Settings),
      ]).catch(() => ({ engine: "whisper-cpp" as const, micDeviceIndex: null, micDeviceName: null })),
      Promise.race([
        window.electronAPI.listDevices(),
        timeout(5000, [] as AudioDevice[]),
      ]).catch(() => [] as AudioDevice[]),
    ]);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return;
  }
  showRecordIdle();
}

function showRecordIdle(): void {
  const hint = settings.micDeviceName
    ? `${settings.micDeviceName} · ${settings.engine}`
    : "No microphone configured";
  $("record-idle-hint").textContent = hint;
  showState("record-idle");
}

// ─── Nav handlers ─────────────────────────────────────────────────────────────

function onNavRecord(): void {
  if (currentState === "recording") return;
  showRecordIdle();
}

async function onNavFiles(): Promise<void> {
  showState("files");
  await loadFilesList();
}

async function onNavSettings(): Promise<void> {
  if (devices.length === 0) {
    devices = await window.electronAPI.listDevices().catch(() => []);
  }
  populateSelect($<HTMLSelectElement>("settings-device-select"), devices, settings.micDeviceIndex);
  showState("settings");
}

// ─── Record flow ──────────────────────────────────────────────────────────────

async function onRecord(): Promise<void> {
  if (settings.micDeviceIndex != null) {
    await startRecordingWithDevice(settings.micDeviceIndex);
  } else {
    populateSelect($<HTMLSelectElement>("device-select"), devices, null);
    showState("device-select");
  }
}

async function onDeviceSelectConfirm(): Promise<void> {
  const idx = parseInt($<HTMLSelectElement>("device-select").value, 10);
  const device = devices.find((d) => d.index === idx);
  if (device) {
    settings = { ...settings, micDeviceIndex: idx, micDeviceName: device.name };
    await window.electronAPI.saveSettings({ micDeviceIndex: idx, micDeviceName: device.name });
  }
  await startRecordingWithDevice(idx);
}

async function startRecordingWithDevice(deviceIndex: number): Promise<void> {
  showState("loading");
  let result: StartResult;
  try {
    result = await window.electronAPI.startRecording(deviceIndex);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return;
  }

  elapsedSeconds = 0;
  pendingNotes = [];
  $("timer").textContent = "00:00";
  $("notes-list").innerHTML = "";
  $("note-form").classList.add("hidden");
  $("btn-add-note").classList.remove("hidden");

  const sysRow = $("waveform-sys-row");
  if (result.hasSystemAudio) {
    sysRow.classList.remove("hidden");
  } else {
    sysRow.classList.add("hidden");
  }

  unsubTick = window.electronAPI.onTick((elapsed) => {
    elapsedSeconds = elapsed;
    $("timer").textContent = formatTime(elapsed);
  });

  showState("recording");
  startWaveform(result.hasSystemAudio);
}

// ─── Stop & transcribe ────────────────────────────────────────────────────────

async function onStop(): Promise<void> {
  if (unsubTick) { unsubTick(); unsubTick = null; }
  stopWaveform();
  showState("stopping");

  let stopResult: StopResult;
  try {
    stopResult = await window.electronAPI.stopRecording();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return;
  }

  const notes = [...pendingNotes];
  const { micPath, sysPath, baseName } = stopResult;

  await transcribeAndShowDone(
    () =>
      sysPath
        ? window.electronAPI.transcribeDual(micPath, sysPath, baseName, notes)
        : window.electronAPI.transcribeSingle(micPath),
    true,
    baseName
  );
}

async function transcribeAndShowDone(
  transcribe: () => Promise<TranscriptResult>,
  isRecording: boolean,
  baseName: string
): Promise<void> {
  unsubProgress = window.electronAPI.onTranscriptionProgress((msg) => {
    $("transcription-progress").textContent = msg;
  });
  $("transcription-progress").textContent = "Transcribing…";
  showState("transcribing");

  let result: TranscriptResult;
  try {
    result = await transcribe();
  } catch (err) {
    if (unsubProgress) { unsubProgress(); unsubProgress = null; }
    showError(err instanceof Error ? err.message : String(err));
    return;
  }
  if (unsubProgress) { unsubProgress(); unsubProgress = null; }

  doneBaseName = baseName;
  doneIsRecording = isRecording;
  $<HTMLPreElement>("transcript-text").textContent = result.text || "(no speech detected)";
  $("transcript-path").textContent = result.transcriptPath;

  const renameArea = $("rename-area");
  if (isRecording) {
    $<HTMLInputElement>("rename-input").value = baseName;
    renameArea.classList.remove("hidden");
  } else {
    renameArea.classList.add("hidden");
  }

  showState("done");
}

// ─── Transcribe existing file ─────────────────────────────────────────────────

async function onTranscribeFile(filePath: string): Promise<void> {
  await transcribeAndShowDone(() => window.electronAPI.transcribeSingle(filePath), false, "");
}

// ─── Notes ────────────────────────────────────────────────────────────────────

function onAddNote(): void {
  $("btn-add-note").classList.add("hidden");
  $("note-form").classList.remove("hidden");
  $<HTMLInputElement>("note-input").value = "";
  $<HTMLInputElement>("note-input").focus();
}

function onNoteCancel(): void {
  $("note-form").classList.add("hidden");
  $("btn-add-note").classList.remove("hidden");
}

function onNoteSave(): void {
  const text = $<HTMLInputElement>("note-input").value.trim();
  if (!text) { $<HTMLInputElement>("note-input").focus(); return; }
  const note: Note = {
    recordingOffset: secondsToOffset(elapsedSeconds),
    wallTime: new Date().toISOString(),
    text,
  };
  pendingNotes.push(note);
  renderNote(note);
  onNoteCancel();
}

function renderNote(note: Note): void {
  const item = document.createElement("div");
  item.className = "note-item";
  const timeSpan = document.createElement("span");
  timeSpan.className = "note-time";
  timeSpan.textContent = note.recordingOffset.replace(/\.000$/, "");
  const textSpan = document.createElement("span");
  textSpan.className = "note-text";
  textSpan.textContent = note.text;
  item.appendChild(timeSpan);
  item.appendChild(textSpan);
  $("notes-list").appendChild(item);
  $("notes-list").scrollTop = $("notes-list").scrollHeight;
}

// ─── Rename ───────────────────────────────────────────────────────────────────

async function onRename(): Promise<void> {
  const raw = $<HTMLInputElement>("rename-input").value.trim();
  const newName = raw.replace(/\s+/g, "-").replace(/[/\\:*?"<>|]/g, "");
  if (!newName || newName === doneBaseName) return;
  try {
    await window.electronAPI.renameRecording(doneBaseName, newName);
    const pathEl = $("transcript-path");
    pathEl.textContent = pathEl.textContent?.replace(/[^/\\]+\.txt$/, `${newName}.txt`) ?? "";
    doneBaseName = newName;
    $<HTMLInputElement>("rename-input").value = newName;
  } catch {}
}

// ─── Files panel ──────────────────────────────────────────────────────────────

async function loadFilesList(): Promise<void> {
  const listEl = $("files-list");
  const emptyEl = $("files-empty");
  listEl.innerHTML = "";

  let files: RecordingFile[] = [];
  try {
    files = await window.electronAPI.listRecordings();
  } catch {}

  if (files.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  for (const f of files) {
    const item = document.createElement("div");
    item.className = "file-item";

    const nameEl = document.createElement("span");
    nameEl.className = "file-name";
    nameEl.textContent = cleanFileName(f.name);
    nameEl.title = f.name;

    const metaEl = document.createElement("span");
    metaEl.className = "file-meta";
    metaEl.textContent = formatSize(f.size);

    item.appendChild(nameEl);
    item.appendChild(metaEl);
    listEl.appendChild(item);
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function onSettingsSave(): Promise<void> {
  const idx = parseInt($<HTMLSelectElement>("settings-device-select").value, 10);
  const device = devices.find((d) => d.index === idx);
  if (device) {
    settings = { ...settings, micDeviceIndex: idx, micDeviceName: device.name };
    await window.electronAPI.saveSettings({ micDeviceIndex: idx, micDeviceName: device.name });
  }
  showRecordIdle();
}

// ─── Waveform ─────────────────────────────────────────────────────────────────

const WAVEFORM_BUFFER = 200;
const BAR_W = 3;
const BAR_GAP = 2;

let micAmplitudes: number[] = new Array(WAVEFORM_BUFFER).fill(0);
let sysAmplitudes: number[] = new Array(WAVEFORM_BUFFER).fill(0);
let sysDelayBuf: number[] = new Array(6).fill(0);

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let micStream: MediaStream | null = null;
let waveformRaf: number | null = null;
let hasSystemAudio = false;

async function startWaveform(withSys: boolean): Promise<void> {
  hasSystemAudio = withSys;
  micAmplitudes = new Array(WAVEFORM_BUFFER).fill(0);
  sysAmplitudes = new Array(WAVEFORM_BUFFER).fill(0);
  sysDelayBuf = new Array(6).fill(0);

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);
  } catch {
    // Permission denied or unavailable — animate idle bars instead
  }

  drawLoop();
}

function stopWaveform(): void {
  if (waveformRaf !== null) { cancelAnimationFrame(waveformRaf); waveformRaf = null; }
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  audioCtx?.close();
  audioCtx = null;
  analyser = null;
}

function drawLoop(): void {
  waveformRaf = requestAnimationFrame(drawLoop);

  let micRms = 0;
  if (analyser) {
    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    micRms = Math.min(1, Math.sqrt(sum / buf.length) * 5);
  }

  micAmplitudes.shift();
  micAmplitudes.push(micRms);

  // Sys: delayed + slightly smoothed version of mic
  sysDelayBuf.shift();
  sysDelayBuf.push(micRms);
  const sysRms = sysDelayBuf[0] * 0.75;
  sysAmplitudes.shift();
  sysAmplitudes.push(sysRms);

  drawBars($<HTMLCanvasElement>("waveform-mic"), micAmplitudes);
  if (hasSystemAudio) {
    drawBars($<HTMLCanvasElement>("waveform-sys"), sysAmplitudes);
  }
}

function drawBars(canvas: HTMLCanvasElement, amplitudes: number[]): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.offsetWidth;
  const cssH = canvas.offsetHeight;

  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const barW = BAR_W * dpr;
  const gap = BAR_GAP * dpr;
  const step = barW + gap;
  const numBars = Math.floor(canvas.width / step);
  const startIdx = amplitudes.length - numBars;

  for (let i = 0; i < numBars; i++) {
    const amp = amplitudes[startIdx + i] ?? 0;
    const barH = Math.max(2 * dpr, amp * canvas.height * 0.88);
    const x = i * step;
    const y = (canvas.height - barH) / 2;
    const alpha = 0.25 + amp * 0.75;
    ctx.fillStyle = `rgba(74, 222, 128, ${alpha})`;
    ctx.fillRect(x, y, barW, barH);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatTime(totalSeconds: number): string {
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function secondsToOffset(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.000`;
}

function populateSelect(select: HTMLSelectElement, devList: AudioDevice[], selected: number | null): void {
  select.innerHTML = "";
  for (const d of devList) {
    const opt = document.createElement("option");
    opt.value = String(d.index);
    opt.textContent = d.name;
    if (d.index === selected) opt.selected = true;
    select.appendChild(opt);
  }
}

function cleanFileName(name: string): string {
  return name.replace(/-mic\.(wav|mp3|m4a|ogg|flac|aiff|aac)$/i, "").replace(/\.[^.]+$/, "");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showError(message: string): void {
  $("error-message").textContent = message;
  showState("error");
}

// ─── Event listeners ──────────────────────────────────────────────────────────

navItems.record.addEventListener("click", () => void onNavRecord());
navItems.files.addEventListener("click", () => void onNavFiles());
navItems.settings.addEventListener("click", () => void onNavSettings());

$("btn-record").addEventListener("click", () => void onRecord());
$("btn-device-back").addEventListener("click", showRecordIdle);
$("btn-start-recording").addEventListener("click", () => void onDeviceSelectConfirm());

$("btn-stop").addEventListener("click", () => void onStop());
$("btn-add-note").addEventListener("click", onAddNote);
$("btn-note-cancel").addEventListener("click", onNoteCancel);
$("btn-note-save").addEventListener("click", onNoteSave);
$<HTMLInputElement>("note-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") onNoteSave();
  if (e.key === "Escape") onNoteCancel();
});

$("btn-done-back").addEventListener("click", showRecordIdle);
$("btn-rename").addEventListener("click", () => void onRename());
$<HTMLInputElement>("rename-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") void onRename();
});

$("btn-refresh-files").addEventListener("click", () => void loadFilesList());
$("btn-settings-save").addEventListener("click", () => void onSettingsSave());
$("btn-error-back").addEventListener("click", showRecordIdle);

// ─── Boot ─────────────────────────────────────────────────────────────────────

void boot();
