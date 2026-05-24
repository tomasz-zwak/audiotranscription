export interface Note {
  recordingOffset: string; // "HH:MM:SS.mmm" — elapsed time when Enter was pressed on the note
  wallTime: string;        // ISO 8601 wall-clock time
  text: string;
}

export interface NoteRecord {
  start: string;
  end: string;
  text: string;
  wallTime: string;
}

export function noteToRecord(note: Note): NoteRecord {
  return {
    start: note.recordingOffset,
    end: note.recordingOffset,
    text: note.text,
    wallTime: note.wallTime,
  };
}

export function msToOffset(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const millis = ms % 1000;
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}.${String(millis).padStart(3, "0")}`;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}
