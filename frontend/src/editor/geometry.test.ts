import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import {
  buildingError,
  canvasView,
  openingSegment,
  project,
  removeElement,
  translateElement,
} from "./geometry";

describe("freeform layout editing", () => {
  it("accepts the example and permits an unfinished draft", () => {
    expect(buildingError(example)).toBeNull();
    const empty = {
      ...example,
      walls: [],
      doors: [],
      exits: [],
      spawn_zones: [],
    };
    expect(buildingError(empty, false)).toBeNull();
    expect(buildingError(empty)).toMatch(/exit/);
  });
  it("projects onto angled walls without snapping to cells", () => {
    const wall = {
      id: "angle",
      start: { x: 0, y: 0 },
      end: { x: 10, y: 10 },
      thickness: 0.2,
    };
    const projected = project({ x: 4.4, y: 5 }, wall);
    expect(projected.point.x).toBeCloseTo(4.7);
    expect(projected.point.y).toBeCloseTo(4.7);
    const [a, b] = openingSegment(
      {
        id: "opening",
        wall_id: wall.id,
        offset: Math.SQRT2,
        width: 2 * Math.SQRT2,
      },
      wall,
    );
    expect(a.x).toBeCloseTo(1);
    expect(b.x).toBeCloseTo(3);
  });
  it("drags walls continuously and keeps attached openings", () => {
    const moved = translateElement(
      example,
      { kind: "walls", id: "angled" },
      { x: 0.37, y: -0.21 },
    );
    expect(moved.walls.at(-1)!.start.x).toBeCloseTo(6.87);
    expect(example.walls.at(-1)!.start.x).toBe(6.5);
    const withOpening = translateElement(
      example,
      { kind: "walls", id: "east_wall" },
      { x: -0.5, y: 0 },
    );
    expect(withOpening.exits).toEqual(example.exits);
  });
  it("moves openings along their wall and clamps rectangles inside the workspace", () => {
    const moved = translateElement(
      example,
      { kind: "exits", id: "east" },
      { x: 2, y: 1.35 },
    );
    expect(moved.exits[1]!.offset).toBeCloseTo(8.35);
    const clamped = translateElement(
      example,
      { kind: "spawn_zones", id: "spawn_east" },
      { x: 999, y: 999 },
    );
    expect(clamped.spawn_zones[1]!.x).toBe(26);
    expect(clamped.spawn_zones[1]!.y).toBe(17);
  });
  it("deletes attached openings and cleans blocked exit references", () => {
    const building = { ...example, blocked_exit_ids: ["west"] };
    const removed = removeElement(building, { kind: "walls", id: "west_wall" });
    expect(removed.exits.some((v) => v.id === "west")).toBe(false);
    expect(removed.blocked_exit_ids).toEqual([]);
    expect(building.exits).toHaveLength(2);
  });
  it("rejects overlapping openings, intersecting spawn areas, and impossible occupant area", () => {
    const overlap = structuredClone(example);
    overlap.doors[1]!.offset = overlap.doors[0]!.offset;
    expect(buildingError(overlap)).toMatch(/overlap/);
    const wall = structuredClone(example);
    wall.spawn_zones[0]!.x = 14;
    expect(buildingError(wall)).toMatch(/overlap/);
    const crowded = structuredClone(example);
    crowded.spawn_zones[0]!.count = 1000;
    expect(buildingError(crowded)).toMatch(/area/);
  });
  it("fits extreme workspace aspect ratios without huge canvas allocations", () => {
    const view = canvasView(1200, 800, { ...example, width: 1, height: 1000 });
    expect(view.scale).toBe(0.8);
    expect(view.x).toBeCloseTo(599.6);
    expect(view.y).toBe(0);
  });
});
