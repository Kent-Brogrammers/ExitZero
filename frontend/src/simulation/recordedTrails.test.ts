import { describe, expect, it } from "vitest";
import { createRecordedTrails } from "./recordedTrails";
import type { SimulationResult } from "../types/simulation";
const recording: SimulationResult = {
  width: 10,
  height: 10,
  time_step_seconds: 0.1,
  total_population: 1,
  evacuated: 1,
  remaining: 0,
  trapped: 0,
  status: "completed",
  clearance_steps: 5,
  traffic_samples: [{ x: 1, y: 1, visits: 999 }],
  congestion_samples: [{ x: 1, y: 1, crowd_delay_seconds: 0.6 }],
  frames: [
    { step: 0, agents: [{ id: 1, x: 1, y: 1 }], congestion_samples: [] },
    {
      step: 2,
      agents: [{ id: 1, x: 2, y: 2 }],
      congestion_samples: [{ x: 1, y: 1, crowd_delay_seconds: 0.15 }],
    },
    {
      step: 4,
      agents: [{ id: 1, x: 3, y: 3 }],
      congestion_samples: [{ x: 2, y: 2, crowd_delay_seconds: 0.25 }],
    },
    {
      step: 5,
      agents: [],
      congestion_samples: [{ x: 3, y: 3, crowd_delay_seconds: 0.2 }],
    },
  ],
};
const total = (data: ReturnType<ReturnType<typeof createRecordedTrails>>) =>
  data.bins.reduce((sum, bin) => sum + bin.visits, 0);
describe("progressive backend congestion", () => {
  it("starts empty and accumulates interval weights once, including departing agents", () => {
    const sample = createRecordedTrails(recording);
    expect(total(sample(0))).toBe(0);
    expect(total(sample(1))).toBe(0.15);
    expect(total(sample(1))).toBe(0.15);
    expect(total(sample(3))).toBeCloseTo(0.6);
  });
  it("rebuilds correctly when seeking backwards or resetting", () => {
    const sample = createRecordedTrails(recording);
    sample(3);
    expect(total(sample(1))).toBe(0.15);
    expect(total(sample(0))).toBe(0);
    expect(total(sample(2))).toBe(0.4);
  });
  it("preserves backend totals across sparse frames without mutating results", () => {
    const before = structuredClone(recording);
    expect(total(createRecordedTrails(recording)(3))).toBeCloseTo(
      recording.congestion_samples![0]!.crowd_delay_seconds,
    );
    expect(recording).toEqual(before);
  });
  it("leaves legacy position/traffic recordings clear rather than treating traffic as congestion", () => {
    const legacy = structuredClone(recording);
    delete legacy.congestion_samples;
    for (const frame of legacy.frames) delete frame.congestion_samples;
    expect(total(createRecordedTrails(legacy)(3))).toBe(0);
  });
});
