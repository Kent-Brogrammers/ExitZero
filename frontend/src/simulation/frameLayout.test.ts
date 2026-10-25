import { describe, expect, it } from "vitest";
import { frameLayout } from "./frameLayout";
import { syntheticBuilding as building } from "./playback.fixture";
import { createFrameSampler } from "./interpolation";
import { solidWallSegments, openingLabels } from "../editor/openings";
import {
  openingStartsBlocked,
  setOpeningBlocked,
} from "../editor/openingState";

describe("opening state in live and recorded frames", () => {
  it("closes doors and exits, then restores them on rewind or reopening", () => {
    const original = structuredClone(building);
    const closed = frameLayout(building, {
      step: 10,
      agents: [],
      blocked_opening_ids: ["door", "west"],
    });
    expect(closed.doors).toEqual(building.doors);
    expect(closed.closedDoorIds).toEqual(["door"]);
    expect(openingStartsBlocked(closed, "door")).toBe(true);
    expect(closed.blocked_exit_ids).toEqual(["west"]);
    const reopened = frameLayout(
      { ...building, blocked_exit_ids: ["west"] },
      { step: 20, agents: [], blocked_opening_ids: [] },
    );
    expect(reopened.doors).toEqual(building.doors);
    expect(reopened.closedDoorIds).toEqual([]);
    expect(reopened.blocked_exit_ids).toEqual([]);
    expect(openingStartsBlocked(reopened, "door")).toBe(false);
    expect(frameLayout(building, { step: 0, agents: [] })).toBe(building);
    expect(building).toEqual(original);
  });

  it("retains a closed door's identity and label while filling its collision gap", () => {
    const closed = frameLayout(building, {
      step: 1,
      agents: [],
      blocked_opening_ids: ["door"],
    });
    const door = closed.doors.find((door) => door.id === "door")!;
    const wall = closed.walls.find((wall) => wall.id === door.wall_id)!;
    expect(solidWallSegments(closed, wall)).toHaveLength(1);
    expect(
      openingLabels(closed, 0.02, () => 1).some(
        (label) => label.id === "door" && label.text.startsWith("Closed door"),
      ),
    ).toBe(true);
    expect(building.doors.some((door) => door.id === "door")).toBe(true);
  });

  it("uses recorded reopening state over original step-zero closures without losing symbols or future events", () => {
    const configured = {
      ...setOpeningBlocked(building, "doors", "door", true),
      blocked_exit_ids: ["west"],
      opening_events: [
        { step: 0, opening_id: "door", blocked: true },
        { step: 0, opening_id: "west", blocked: true },
        { step: 20, opening_id: "door", blocked: false },
      ],
    };
    const original = JSON.stringify(configured);
    const open = frameLayout(configured, {
      step: 20,
      agents: [],
      blocked_opening_ids: [],
    });
    expect(open.doors).toEqual(building.doors);
    expect(openingStartsBlocked(open, "door")).toBe(false);
    expect(openingStartsBlocked(open, "west")).toBe(false);
    expect(open.opening_events).toEqual([configured.opening_events[2]]);
    const closed = frameLayout(configured, {
      step: 0,
      agents: [],
      blocked_opening_ids: ["door", "west"],
    });
    expect(openingStartsBlocked(closed, "door")).toBe(true);
    expect(openingStartsBlocked(closed, "west")).toBe(true);
    expect(JSON.stringify(configured)).toBe(original);
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
