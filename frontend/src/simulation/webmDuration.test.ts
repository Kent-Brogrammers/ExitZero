import { describe, expect, it } from "vitest";
import { finalizeWebmDuration } from "./webmDuration";

const info = [0x15, 0x49, 0xa9, 0x66];
function stream(payload: number[], unknown = true) {
  const body = [
    ...info,
    0x80 | payload.length,
    ...payload,
    0x1f,
    0x43,
    0xb6,
    0x75,
    0x83,
    7,
    8,
    9,
  ];
  return new Blob(
    [
      new Uint8Array([
        0x1a,
        0x45,
        0xdf,
        0xa3,
        0x80,
        0x18,
        0x53,
        0x80,
        0x67,
        unknown ? 0xff : 0x80 | body.length,
        ...body,
      ]),
    ],
    { type: "video/webm" },
  );
}
describe("native streaming WebM duration metadata", () => {
  it("adds a finite duration using the timestamp scale without changing encoded cluster bytes", async () => {
    const original = stream([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]); // 1ms ticks
    const result = await finalizeWebmDuration(original, 2.75);
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(result.size).toBe(original.size + 11);
    expect(result.type).toBe(original.type);
    expect(bytes[14]).toBe(0x80 | 18); // Info's adjusted size
    expect([...bytes.slice(22, 25)]).toEqual([0x44, 0x89, 0x88]);
    expect(new DataView(bytes.buffer).getFloat64(25)).toBe(2750);
    expect([...bytes.slice(-8)]).toEqual([
      0x1f, 0x43, 0xb6, 0x75, 0x83, 7, 8, 9,
    ]);
  });
  it("updates existing float durations without growing finite segments", async () => {
    const result = await finalizeWebmDuration(
      stream([0x44, 0x89, 0x84, 0, 0, 0, 0], false),
      1.25,
    );
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(new DataView(bytes.buffer).getFloat32(18)).toBe(1250);
    expect(bytes.length).toBe(30);
  });
  it("fails safely for invalid headers and finite segments without reserved duration", async () => {
    await expect(
      finalizeWebmDuration(new Blob(["not webm"]), 2),
    ).rejects.toThrow();
    await expect(finalizeWebmDuration(stream([]), 0)).rejects.toThrow(
      /duration/,
    );
    await expect(finalizeWebmDuration(stream([], false), 2)).rejects.toThrow(
      /safely/,
    );
  });
});
