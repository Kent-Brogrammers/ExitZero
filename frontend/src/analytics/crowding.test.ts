import { describe, expect, it } from "vitest";
import { createCrowdingTracker, frameCrowding } from "./crowding";
const frame = (step: number, points: number[]) => ({
  step,
  agents: points.map((x, id) => ({ id, x, y: 1 })),
});
describe("crowding after movement", () => {
  it("excludes initial crowds and small movements around the spawn point", () => {
    const tracker = createCrowdingTracker(20, 20);
    tracker.add(frame(0, [1, 1.2, 1.4]));
    tracker.add(frame(1, [1.5, 1.7, 1.9]));
    expect(tracker.getSnapshot()).toEqual([]);
    tracker.add(frame(2, [5, 5.2, 5.4]));
    expect(tracker.getSnapshot()[0]!.count).toBe(3);
    expect(tracker.getSnapshot()[0]!.frame.step).toBe(2);
  });
  it("keeps counting people who stop in queues after moving", () => {
    const tracker = createCrowdingTracker(20, 20);
    tracker.add(frame(0, [1, 1.2]));
    tracker.add(frame(1, [5, 5.2]));
    tracker.add(frame(2, [5, 5.2]));
    tracker.add(frame(3, []));
    expect(tracker.getSnapshot()[0]!.count).toBe(2);
    expect(tracker.getSnapshot()[0]!.frame.step).toBe(1);
    expect(frameCrowding(frame(3, []), 20, 20)).toEqual([]);
  });
  it("uses stable IDs and excludes unmoved people from snapshot evidence", () => {
    const tracker = createCrowdingTracker(20, 20);
    tracker.add(frame(0, [1, 5.2, 1.4]));
    tracker.add({
      step: 1,
      agents: [
        { id: 2, x: 5.4, y: 1 },
        { id: 1, x: 5.2, y: 1 },
        { id: 0, x: 5, y: 1 },
      ],
    });
    const spot = tracker.getSnapshot()[0]!;
    expect(spot.count).toBe(2);
    expect(spot.frame.agents.map((a) => a.id)).toEqual([2, 0]);
  });
  it("resets movement history when cleared or rewound", () => {
    const tracker = createCrowdingTracker(20, 20);
    tracker.add(frame(0, [1]));
    tracker.add(frame(2, [5]));
    expect(tracker.getSnapshot()).toHaveLength(1);
    tracker.add(frame(0, [5]));
    expect(tracker.getSnapshot()).toEqual([]);
    tracker.add(frame(1, [5]));
    expect(tracker.getSnapshot()).toEqual([]);
    tracker.add(null);
    tracker.add(frame(0, [1]));
    expect(tracker.getSnapshot()).toEqual([]);
  });
  it("ranks distinct zones by simultaneous count rather than cumulative visits", () => {
    const tracker = createCrowdingTracker(20, 20);
    tracker.add(frame(0, [1, 1.2, 1.4]));
    tracker.add(frame(1, [5, 5.2, 5.4]));
    for (let step = 2; step < 10; step++) tracker.add(frame(step, [9]));
    expect(tracker.getSnapshot().map((s) => s.count)).toEqual([3, 1]);
    expect(frameCrowding(frame(2, [20]), 20, 20)[0]!.x).toBe(18);
  });
});
