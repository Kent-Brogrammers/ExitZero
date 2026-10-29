import { expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario, Point } from "../types/simulation";
import { classifyDoors } from "./exteriorDoors";
import { openingStartsBlocked } from "./openingState";

function fixture(
  points: Point[] = [
    { x: 3, y: 3 },
    { x: 13, y: 3 },
    { x: 13, y: 13 },
    { x: 3, y: 13 },
  ],
): BuildingScenario {
  return {
    ...structuredClone(example),
    width: 20,
    height: 20,
    doors: [],
    exits: [],
    blocked_exit_ids: [],
    windows: [],
    spawn_zones: [],
    walls: points.map((start, i) => ({
      id: `wall-${i}`,
      start,
      end: points[(i + 1) % points.length]!,
      thickness: 0.2,
    })),
  };
}
it("classifies exterior doors away from workspace edges, retaining IDs and blocked states", () => {
  const b = fixture();
  b.doors = [{ id: "outside", wall_id: "wall-0", offset: 3, width: 1 }];
  b.opening_events = [{ step: 0, opening_id: "outside", blocked: true }];
  const classified = classifyDoors(b);
  expect(classified.doors).toHaveLength(0);
  expect(classified.exits[0]!.id).toBe("outside");
  expect(openingStartsBlocked(classified, "outside")).toBe(true);
  expect(classified.blocked_exit_ids).toEqual(["outside"]);
  b.walls.splice(1, 1);
  const opened = classifyDoors({ ...classified, walls: b.walls });
  expect(opened.exits).toHaveLength(0);
  expect(opened.doors[0]!.id).toBe("outside");
  expect(opened.blocked_exit_ids).toEqual([]);
  expect(openingStartsBlocked(opened, "outside")).toBe(true);
});
it("keeps doors between rooms as doors, including T junctions and reversed walls", () => {
  const b = fixture();
  b.walls.push({
    id: "divider",
    start: { x: 8, y: 3 },
    end: { x: 8, y: 13 },
    thickness: 0.2,
  });
  b.doors = [
    { id: "inside", wall_id: "divider", offset: 3, width: 1 },
    { id: "outside", wall_id: "wall-3", offset: 3, width: 1 },
  ];
  const result = classifyDoors(b);
  expect(result.doors.map((o) => o.id)).toEqual(["inside"]);
  expect(result.exits.map((o) => o.id)).toEqual(["outside"]);
  const wall = b.walls[3]!;
  [wall.start, wall.end] = [wall.end, wall.start];
  expect(classifyDoors(b).exits.map((o) => o.id)).toEqual(["outside"]);
});
it("recognizes angled perimeter doors and leaves isolated walls as ordinary doors", () => {
  const b = fixture([
    { x: 3, y: 3 },
    { x: 15, y: 7 },
    { x: 6, y: 16 },
  ]);
  b.doors = [{ id: "angle", wall_id: "wall-0", offset: 3, width: 1 }];
  expect(classifyDoors(b).exits).toHaveLength(1);
  b.walls = b.walls.slice(0, 1);
  expect(classifyDoors(b).exits).toHaveLength(0);
});
