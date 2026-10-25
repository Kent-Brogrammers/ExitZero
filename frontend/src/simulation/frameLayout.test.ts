import { describe, expect, it } from "vitest";
import { frameLayout } from "./frameLayout";
import { syntheticBuilding as building } from "./playback.fixture";
import { createFrameSampler } from "./interpolation";

describe("opening state in live and recorded frames", () => {
  it("closes doors and exits, then restores them on rewind or reopening", () => {
    const original = structuredClone(building);
    const closed = frameLayout(building, {
      step: 10,
      agents: [],
      blocked_opening_ids: ["door", "west"],
    });
    expect(closed.doors).toEqual([]);
    expect(closed.blocked_exit_ids).toEqual(["west"]);
    const reopened = frameLayout(
      { ...building, blocked_exit_ids: ["west"] },
      { step: 20, agents: [], blocked_opening_ids: [] },
    );
    expect(reopened.doors).toEqual(building.doors);
    expect(reopened.blocked_exit_ids).toEqual([]);
    expect(frameLayout(building, { step: 0, agents: [] })).toBe(building);
    expect(building).toEqual(original);
  });

  it("keeps interpolation on the recorded side of a closed door", () => {
    const frames = [
      {
        step: 0,
        agents: [{ id: 0, x: 1, y: 1.5 }],
        blocked_opening_ids: ["door"],
      },
      { step: 10, agents: [{ id: 0, x: 3, y: 1.5 }], blocked_opening_ids: [] },
    ];
    const sample = createFrameSampler(building, frames, 0.1);
    expect(sample(0.5)?.agents[0]?.x).toBe(1);
    expect(sample(0.5)?.blocked_opening_ids).toEqual(["door"]);
    expect(sample(1)?.blocked_opening_ids).toEqual([]);
  });
});
