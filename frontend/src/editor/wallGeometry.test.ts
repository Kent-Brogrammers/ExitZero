import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import { solidWallSegments, wallPolygon } from "./wallGeometry";

describe("flat-ended wall openings", () => {
  it("cuts the exact opening interval and keeps disabled exits solid", () => {
    const wall = {
      id: "wall",
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
      thickness: 0.2,
    };
    const building = {
      ...example,
      walls: [wall],
      doors: [],
      exits: [{ id: "out", wall_id: "wall", offset: 3, width: 0.5 }],
      blocked_exit_ids: [],
    };
    expect(solidWallSegments(building, wall)).toEqual([
      [
        { x: 0, y: 0 },
        { x: 3, y: 0 },
      ],
      [
        { x: 3.5, y: 0 },
        { x: 10, y: 0 },
      ],
    ]);
    expect(wallPolygon({ x: 0, y: 0 }, { x: 3, y: 0 }, 0.2)).toEqual([
      { x: 0, y: 0.1 },
      { x: 3, y: 0.1 },
      { x: 3, y: -0.1 },
      { x: 0, y: -0.1 },
    ]);
    expect(
      solidWallSegments({ ...building, blocked_exit_ids: ["out"] }, wall),
    ).toEqual([
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    ]);
  });
  it("positions diagonal cuts along wall length and leaves its inputs intact", () => {
    const wall = {
      id: "diagonal",
      start: { x: 1, y: 2 },
      end: { x: 7, y: 10 },
      thickness: 0.4,
    };
    const building = {
      ...example,
      walls: [wall],
      doors: [{ id: "door", wall_id: "diagonal", offset: 2, width: 1 }],
      exits: [],
    };
    const before = structuredClone(building);
    const segments = solidWallSegments(building, wall);
    expect(segments[0]![1]).toEqual({ x: 2.2, y: 3.6 });
    expect(segments[1]![0]).toEqual({ x: 2.8, y: 4.4 });
    expect(building).toEqual(before);
  });
});
