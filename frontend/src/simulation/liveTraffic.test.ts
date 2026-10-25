import { describe, expect, it } from "vitest";
import { createLiveTraffic } from "./liveTraffic";
const frame = (step: number, x = 1) => ({ step, agents: [{ id: 1, x, y: 1 }] });
describe("live heat accumulation", () => {
  it("starts clear, accumulates delivered positions, and ignores duplicate redraws", () => {
    const sample = createLiveTraffic(10, 10);
    expect(sample(frame(0)).max).toBe(0);
    expect(sample(frame(1)).max).toBe(1);
    expect(sample(frame(1)).max).toBe(1);
    expect(sample(frame(2)).max).toBe(2);
  });
  it("resets between runs and never invents omitted frames", () => {
    const sample = createLiveTraffic(10, 10);
    sample(frame(5));
    expect(sample(frame(10)).max).toBe(2);
    expect(sample(null).max).toBe(0);
    sample(frame(3));
    expect(sample(frame(0)).max).toBe(0);
  });
  it("retains trails after everyone leaves and filters invalid positions", () => {
    const sample = createLiveTraffic(10, 10);
    sample(frame(1));
    sample(frame(2, 20));
    expect(sample({ step: 3, agents: [] }).max).toBe(1);
  });
});
