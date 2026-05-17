import { describe, expect, test } from "bun:test";
import { listAudioDevices, parseAudioDevices } from "./devices";

const SAMPLE_OUTPUT = `
[AVFoundation indev @ 0x157e05e00] AVFoundation video devices:
[AVFoundation indev @ 0x157e05e00] [0] FaceTime HD Camera
[AVFoundation indev @ 0x157e05e00] [1] Capture screen 0
[AVFoundation indev @ 0x157e05e00] AVFoundation audio devices:
[AVFoundation indev @ 0x157e05e00] [0] Blackhole audio input
[AVFoundation indev @ 0x157e05e00] [1] BlackHole 2ch
[AVFoundation indev @ 0x157e05e00] [2] MacBook Pro Microphone
[in#0 @ 0x600001da0700] Error opening input: Input/output error
`;

describe("parseAudioDevices", () => {
  test("returns only audio devices, not video", () => {
    const devices = parseAudioDevices(SAMPLE_OUTPUT);
    expect(devices).toHaveLength(3);
    expect(devices.every((d) => d.name !== "FaceTime HD Camera")).toBe(true);
    expect(devices.every((d) => d.name !== "Capture screen 0")).toBe(true);
  });

  test("parses index and name correctly", () => {
    const devices = parseAudioDevices(SAMPLE_OUTPUT);
    expect(devices[0]).toEqual({ index: 0, name: "Blackhole audio input" });
    expect(devices[1]).toEqual({ index: 1, name: "BlackHole 2ch" });
    expect(devices[2]).toEqual({ index: 2, name: "MacBook Pro Microphone" });
  });

  test("returns empty array when no audio section present", () => {
    const output = `
[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] FaceTime HD Camera
`;
    expect(parseAudioDevices(output)).toEqual([]);
  });

  test("returns empty array for empty string", () => {
    expect(parseAudioDevices("")).toEqual([]);
  });
});

describe("listAudioDevices", () => {
  test("returns an array without throwing", async () => {
    const devices = await listAudioDevices();
    expect(Array.isArray(devices)).toBe(true);
    for (const d of devices) {
      expect(typeof d.index).toBe("number");
      expect(typeof d.name).toBe("string");
      expect(d.name.length).toBeGreaterThan(0);
    }
  });
});
