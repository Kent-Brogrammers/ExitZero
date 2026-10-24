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
  traffic_samples: [],
  frames: [
    { step: 0, agents: [{ id: 1, x: 1, y: 1 }] },
    { step: 2, agents: [{ id: 1, x: 2, y: 2 }] },
    { step: 4, agents: [{ id: 1, x: 3, y: 3 }] },
    { step: 5, agents: [] },
  ],
};
const total = (data: ReturnType<ReturnType<typeof createRecordedTrails>>) =>
  data.bins.reduce((sum, bin) => sum + bin.visits, 0);
describe("progressive playback trails", () => {
  it("starts empty and counts each recorded position once, independent of redraw rate", () => {
    const sample = createRecordedTrails(recording);
    expect(total(sample(0))).toBe(0);
    expect(total(sample(1))).toBe(1);
    expect(total(sample(1))).toBe(1);
    expect(total(sample(3))).toBe(2);
  });
  it("rebuilds correctly when seeking backwards or resetting", () => {
    const sample = createRecordedTrails(recording);
    sample(3);
    expect(total(sample(1))).toBe(1);
    expect(total(sample(0))).toBe(0);
    expect(total(sample(2))).toBe(2);
  });
  it("does not invent observations for omitted simulation ticks or mutate results", () => {
    const before = structuredClone(recording);
    expect(total(createRecordedTrails(recording)(3))).toBe(2);
    expect(recording).toEqual(before);
  });
});
