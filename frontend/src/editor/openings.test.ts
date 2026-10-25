import { describe, it, expect } from "vitest";
import example from "../../../shared/examples/building.json";
import { buildingError, wallLength } from "./geometry";
import { openingLabels, solidWallSegments, hitOpening } from "./openings";
import type { BuildingScenario } from "../types/simulation";
function fixture(angled = false): BuildingScenario {
  return {
    ...structuredClone(example),
    walls: [
      {
        id: "wall",
        start: { x: 2, y: 2 },
        end: angled ? { x: 14, y: 11 } : { x: 20, y: 2 },
        thickness: 0.2,
      },
    ],
    doors: [
      { id: "a", wall_id: "wall", offset: 2, width: 1 },
      { id: "b", wall_id: "wall", offset: 3, width: 1 },
    ],
    exits: [],
    spawn_zones: [],
    obstructions: [],
    blocked_exit_ids: [],
  };
}
describe("opening intervals and labels", () => {
  it.each([false, true])(
    "keeps touching doors distinct and draws a continuous gap (angled=%s)",
    (angled) => {
      const b = fixture(angled),
        segments = solidWallSegments(b, b.walls[0]!);
      expect(buildingError(b, false)).toBeNull();
      expect(segments).toHaveLength(2);
      expect(b.doors.map((o) => o.id)).toEqual(["a", "b"]);
      expect(JSON.parse(JSON.stringify(b))).toEqual(b);
    },
  );
  it.each([false, true])(
    "rejects overlapping/out-of-range intervals and retains real separators (angled=%s)",
    (angled) => {
      const b = fixture(angled);
      b.doors[1]!.offset = 2.99;
      expect(buildingError(b, false)).toMatch(/overlap/);
      b.doors[1]!.offset = wallLength(b.walls[0]!);
      expect(buildingError(b, false)).toMatch(/fit/);
      b.doors[1]!.offset = 3.05;
      expect(buildingError(b, false)).toBeNull();
      expect(solidWallSegments(b, b.walls[0]!)).toHaveLength(3);
    },
  );
  it("does not cut a blocked exit through solid wall", () => {
    const b = fixture();
    b.exits = [{ id: "blocked", wall_id: "wall", offset: 6, width: 1 }];
    b.blocked_exit_ids = ["blocked"];
    expect(solidWallSegments(b, b.walls[0]!)).toHaveLength(2);
    b.blocked_exit_ids = [];
    expect(solidWallSegments(b, b.walls[0]!)).toHaveLength(3);
  });
  it.each([false, true])(
    "separates nearby labels without changing geometry (angled=%s)",
    (angled) => {
      const b = fixture(angled),
        before = JSON.stringify(b),
        labels = openingLabels(b, 0.04, (text) => text.length * 0.24);
      expect(labels).toHaveLength(2);
      const [a, c] = labels;
      expect(
        a!.x >= c!.x + c!.width ||
          c!.x >= a!.x + a!.width ||
          a!.y - a!.height >= c!.y ||
          c!.y - c!.height >= a!.y,
      ).toBe(true);
      expect(JSON.stringify(b)).toBe(before);
    },
  );
});

it.each([false, true])(
  "selects either touching door by its actual interval even within the neighbour's hit tolerance (angled=%s)",
  (angled) => {
    const b = fixture(angled),
      wall = b.walls[0]!,
      length = wallLength(wall);
    for (const [offset, id] of [
      [2.99, "a"],
      [3.01, "b"],
    ] as const) {
      const p = {
        x: wall.start.x + ((wall.end.x - wall.start.x) * offset) / length,
        y: wall.start.y + ((wall.end.y - wall.start.y) * offset) / length,
      };
      expect(hitOpening(b, p, 0.5)).toEqual({ kind: "doors", id });
    }
  },
);

it.each([false, true])(
  "omits rounding remnants at full-segment opening edges but preserves real walls (angled=%s)",
  (angled) => {
    const b = fixture(angled),
      wall = b.walls[0]!,
      length = wallLength(wall),
      mid = length / 2,
      rounding = 1e-12;
    b.doors = [
      {
        id: "a",
        wall_id: wall.id,
        offset: rounding,
        width: mid - 2 * rounding,
      },
      {
        id: "b",
        wall_id: wall.id,
        offset: mid + rounding,
        width: length - mid - 2 * rounding,
      },
    ];
    expect(buildingError(b, false)).toBeNull();
    expect(solidWallSegments(b, wall)).toEqual([]);
    b.doors[1]!.offset = mid + 0.05;
    b.doors[1]!.width = length - mid - 0.05;
    expect(solidWallSegments(b, wall)).toHaveLength(1);
    b.doors = [];
    b.exits = [
      {
        id: "exit",
        wall_id: wall.id,
        offset: rounding,
        width: length - 2 * rounding,
      },
    ];
    expect(solidWallSegments(b, wall)).toEqual([]);
    b.blocked_exit_ids = ["exit"];
    expect(solidWallSegments(b, wall)).toHaveLength(1);
  },
);
