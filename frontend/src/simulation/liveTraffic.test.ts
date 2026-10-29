import { describe, expect, it } from "vitest";
import { createLiveCongestion, createLiveTraffic } from "./liveTraffic";
import { congestionBins } from "../analytics/traffic";
const frame = (step: number, delay = 0, x = 1) => ({
  step,
  agents: [{ id: 1, x, y: 1 }],
  congestion_samples: delay ? [{ x, y: 1, crowd_delay_seconds: delay }] : [],
});
describe("live congestion accumulation", () => {
  it("starts clear and consumes backend delay exactly once despite duplicate redraws", () => {
    const sample = createLiveTraffic(10, 10);
    expect(sample(frame(0)).max).toBe(0);
    expect(sample(frame(1, 0.15)).max).toBe(0.15);
    expect(sample(frame(1, 0.15)).max).toBe(0.15);
    expect(sample(frame(2, 0.25)).max).toBe(0.4);
  });
  it("uses interval totals across skipped physics ticks and resets between runs", () => {
    const sample = createLiveTraffic(10, 10);
    sample(frame(5, 0.5));
    expect(sample(frame(10, 0.75)).max).toBe(1.25);
    expect(sample(null).max).toBe(0);
    sample(frame(3, 0.3));
    expect(sample(frame(0)).max).toBe(0);
  });
  it("retains delay after everyone leaves and filters invalid samples", () => {
    const sample = createLiveTraffic(10, 10);
    sample(frame(1, 0.4));
    sample(frame(2, 8, 20));
    expect(sample({ step: 3, agents: [], congestion_samples: [] }).max).toBe(
      0.4,
    );
  });
  it("never infers heat from crowded positions without backend delay", () => {
    const sample = createLiveTraffic(10, 10);
    const busy = {
      step: 1,
      agents: Array.from({ length: 20 }, (_, id) => ({ id, x: 1, y: 1 })),
    };
    expect(sample(busy).max).toBe(0);
    expect(sample({ ...busy, step: 2, congestion_samples: [] }).max).toBe(0);
  });
  it("distinguishes unavailable legacy data from measured zero and preserves delivered snapshots", () => {
    const sample = createLiveCongestion(10, 10);
    expect(sample({ step: 0, agents: [] })).toBeUndefined();
    expect(sample(frame(1))).toEqual([]);
    const first = sample(frame(2, 0.2));
    sample(frame(3, 0.3));
    expect(first).toEqual([{ x: 1.125, y: 1.125, crowd_delay_seconds: 0.2 }]);
    expect(sample(null)).toBeUndefined();
  });
  it("keeps fractional-width spatial bins stable when interval samples are rebinned", () => {
    const width = 43;
    const size = width / 160;
    const samples = Array.from({ length: 160 }, (_, column) => ({
      x: (column + 0.5) * size,
      y: 1,
      crowd_delay_seconds: 0.25,
    }));
    const accumulate = createLiveTraffic(width, 10);
    accumulate({ step: 0, agents: [], congestion_samples: [] });
    accumulate({ step: 5, agents: [], congestion_samples: samples });
    const actual = accumulate({
      step: 10,
      agents: [],
      congestion_samples: samples,
    });
    expect(actual).toEqual(congestionBins([...samples, ...samples], width, 10));
  });
});
