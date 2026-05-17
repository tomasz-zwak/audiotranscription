export interface AudioDevice {
  index: number;
  name: string;
}

export async function listAudioDevices(): Promise<AudioDevice[]> {
  const proc = Bun.spawn(
    ["ffmpeg", "-f", "avfoundation", "-list_devices", "true", "-i", "null"],
    { stderr: "pipe", stdout: "pipe", stdin: "ignore" }
  );

  // Read stderr and wait for exit in parallel — reading after exited yields empty stream
  const [output] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return parseAudioDevices(output);
}

export function parseAudioDevices(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  let inAudioSection = false;

  for (const line of output.split("\n")) {
    if (line.includes("AVFoundation audio devices")) {
      inAudioSection = true;
      continue;
    }
    if (!inAudioSection) continue;

    const match = line.match(/\[(\d+)\]\s+(.+)/);
    if (match) {
      devices.push({ index: parseInt(match[1], 10), name: match[2].trim() });
    }
  }

  return devices;
}
