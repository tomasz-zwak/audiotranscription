# Todo

## Roadmap

### Priority legend
- Quick win — low effort, immediate value, no new infrastructure
- Medium — meaningful effort, high strategic value
- Big bet — significant investment, transformative impact

---

### M1 — Terminal UX
*Build on what works today. Ships fast, improves daily use immediately.*

- [ ] **[Quick win]** Slash command palette — press `/` during recording to open a command list
- [ ] **[Quick win]** Timestamped notes — "add note" command lets the user type a note mid-recording; stored with timestamp and attached to the transcript output
- [ ] **[Quick win]** Speaker tagging — `/speaker <name>` command annotates the current transcription chunk with the speaker's name (e.g. `/speaker Steve`); manual tagging now, automatic diarization later via WhisperX (M2)
- [ ] **[Medium]** Real-time transcription display — text appears on screen as audio is recorded

**Why first:** No new dependencies, zero infrastructure changes. Notes + slash commands form the interaction model that the future GUI will inherit. Speaker tags created here become the training signal for automatic diarization in M2. Real-time display is the feature users will notice most.

---

### M2 — Transcription engine upgrade
*Better transcripts make everything downstream more valuable.*

- [ ] **[Medium]** WhisperX migration — evaluate and migrate from current whisper-node; benefits: better accuracy, word-level timestamps, speaker diarization
- [ ] **[Quick win]** Multi-language support — Polish, German, others; likely a config change once WhisperX is in place

**Why second:** WhisperX is a force multiplier. Better transcripts improve real-time display (M1), unlock speaker-aware meeting notes (M4), and make multi-language nearly free. Research already filed — do this before building more on top of the current engine.

---

### M3 — Cross-platform + GUI
*Reach and usability for non-technical users.*

- [ ] **[Big bet]** Graphical UI — Electron or Tauri; real-time transcript panel, notes sidebar, command palette mirroring M1 slash commands
- [ ] **[Big bet]** Windows support — two-channel recording (mic + system audio) without manual audio routing config; needs a Windows audio capture API (ScreenCaptureKit is macOS-only)

**Why third:** The GUI makes real-time transcription and AI notes genuinely usable outside the terminal. Windows parity requires the GUI anyway — a console-only Windows experience is a dead end. Evaluate Electron vs Tauri before committing; Electron ships faster, Tauri is lighter and more native.

---

### M4 — AI layer
*The crown jewel. All previous milestones feed into this.*

- [ ] **[Big bet]** AI meeting notes — post-recording LLM pass over the full transcript; output: meeting minutes, action items, key decisions
- [ ] **[Big bet]** Context memory — model retains meaning across a session so notes are coherent rather than chunk summaries
- [ ] **[Big bet]** LLM API integration — connect to a capable model (Claude, GPT-4o, etc.) for the notes generation step

**Why last:** Depends on transcript quality (M2) and a UI to display structured output (M3). With good transcripts and speaker labels from WhisperX, the LLM has far better material to work with. This milestone turns the tool from "recorder + transcript" into "meeting intelligence."

---

## Research

- [ ] Check [whisperX](https://github.com/m-bain/whisperX) — potential replacement/upgrade for transcription (feeds M2)
- [ ] Check [@lumen-labs-dev/whisper-node](https://www.npmjs.com/package/@lumen-labs-dev/whisper-node) — potential replacement for current whisper-node integration (feeds M2)
- [ ] Investigate Windows audio capture APIs (WASAPI, alternatives to Virtual Audio Cable) for cross-platform two-channel recording (feeds M3)
- [ ] Evaluate Electron vs Tauri for GUI milestone (feeds M3)
