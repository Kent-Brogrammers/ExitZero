import { describe, expect, it } from "vitest";
import { createCrowdingTracker, frameCrowding } from "./crowding";
const frame = (step: number, points: number[]) => ({
  step,
  agents: points.map((x, id) => ({ id, x, y: 1 })),
});
describe("peak simultaneous crowding", () => {
  it("ranks simultaneous people, not cumulative route visits", () => {
    const tracker = createCrowdingTracker(20, 20);
    tracker.add(frame(0, [1, 1.2, 1.4]));
    for (let step = 1; step < 10; step++) tracker.add(frame(step, [5]));
    expect(tracker.getSnapshot()[0]!.count).toBe(3);
    expect(tracker.getSnapshot()[1]!.count).toBe(1);
    expect(tracker.getSnapshot()[0]!.frame.step).toBe(0);
  });
  it("current crowding clears after occupants leave while peak snapshots remain", () => {
    const tracker = createCrowdingTracker(20, 20);
    tracker.add(frame(1, [1, 1.2]));
    tracker.add(frame(2, []));
    expect(frameCrowding(frame(2, []), 20, 20)).toEqual([]);
    expect(tracker.getSnapshot()[0]!.count).toBe(2);
    tracker.add(null);
    expect(tracker.getSnapshot()).toEqual([]);
  });
  it("returns three distinct zones, preserves earliest ties, and handles bounds", () => {
    const tracker = createCrowdingTracker(20, 20);
    tracker.add(frame(0, [1, 3, 5, 7, 20, -1, 21]));
    tracker.add(frame(1, [1, 3, 5]));
    expect(tracker.getSnapshot()).toHaveLength(3);
    expect(tracker.getSnapshot().map((s) => s.x)).toEqual([0, 2, 4]);
    expect(tracker.getSnapshot().every((s) => s.frame.step === 0)).toBe(true);
    expect(frameCrowding(frame(2, [20]), 20, 20)[0]!.x).toBe(18);
  });
});
