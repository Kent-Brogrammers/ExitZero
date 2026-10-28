import { describe, it, expect } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import {
  buildingError,
  rectanglesOverlap,
  wallIntersectsRectangle,
  type Selection,
} from "./geometry";
import { nameProblem } from "./names";
import { addWallShape } from "./shapes";
import {
  combineSelection,
  toggleSelection,
  marqueeSelection,
  selectionBounds,
  moveSelection,
  removeSelection,
  resizeSelection,
  rotateObstruction,
} from "./selection";
import { duplicateSelection } from "./duplication";
function duplicateObstruction(
  building: BuildingScenario,
  id: string,
  copyId: string,
) {
  return duplicateSelection(
    building,
    [{ kind: "obstructions", id }],
    () => copyId,
  ).building;
}
function fixture(): BuildingScenario {
  return {
    ...structuredClone(example),
    walls: [
      {
        id: "wall",
        start: { x: 2, y: 2 },
        end: { x: 20, y: 2 },
        thickness: 0.2,
      },
    ],
    doors: [{ id: "door", wall_id: "wall", offset: 2, width: 1 }],
    exits: [{ id: "exit", wall_id: "wall", offset: 12, width: 1 }],
    spawn_zones: [{ id: "spawn", x: 5, y: 5, width: 2, height: 2, count: 2 }],
    obstructions: [{ id: "object", x: 12, y: 10, width: 2, height: 1 }],
    stair_areas: [
      {
        id: "stair",
        name: "Main stair",
        x: 15,
        y: 5,
        width: 2,
        height: 3,
        orientation_degrees: 90,
      },
    ],
    blocked_exit_ids: ["exit"],
  };
}

describe("individual object duplication", () => {
  it("creates an independent physical copy with a new ID, name and valid JSON, preserving references", () => {
    const original = fixture();
    original.obstructions[0]!.name = "Conference table";
    const before = structuredClone(original);
    const next = duplicateObstruction(original, "object", "copy");
    const copy = next.obstructions.at(-1)!;
    expect(copy).toMatchObject({
      id: "copy",
      name: "Conference table (copy)",
      width: 2,
      height: 1,
      y: 10,
    });
    expect(copy.x).toBeCloseTo(14.3048);
    expect(rectanglesOverlap(copy, original.obstructions[0]!)).toBe(false);
    expect(next.obstructions[0]).toEqual(before.obstructions[0]);
    for (const key of [
      "walls",
      "doors",
      "exits",
      "spawn_zones",
      "blocked_exit_ids",
      "stair_areas",
    ] as const)
      expect(next[key]).toBe(original[key]);
    expect(original).toEqual(before);
    expect(copy).not.toBe(original.obstructions[0]);
    expect(buildingError(next)).toBeNull();
    expect(JSON.parse(JSON.stringify(next))).toEqual(next);
  });

  it("preserves rotated dimensions and generates distinct names when repeatedly duplicating the selected copy", () => {
    const rotated = rotateObstruction(fixture(), "object");
    const first = duplicateObstruction(rotated, "object", "copy-1");
    const second = duplicateObstruction(first, "copy-1", "copy-2");
    expect(second.obstructions.map((o) => o.name)).toEqual([
      undefined,
      "Obstruction 1 (copy)",
      "Obstruction 1 (copy 2)",
    ]);
    expect(second.obstructions.at(-1)).toMatchObject({
      id: "copy-2",
      width: 1,
      height: 2,
    });
    expect(new Set(second.obstructions.map((o) => o.id)).size).toBe(3);
    expect(buildingError(second)).toBeNull();
  });

  it("finds another nearby position when furniture and thick walls occupy the first choices", () => {
    const original = fixture();
    original.obstructions.push({
      id: "occupied",
      x: 14,
      y: 10,
      width: 3,
      height: 1,
    });
    original.walls.push({
      id: "below",
      start: { x: 12, y: 12.1 },
      end: { x: 15, y: 12.1 },
      thickness: 0.4,
    });
    const next = duplicateObstruction(original, "object", "copy");
    const copy = next.obstructions.at(-1)!;
    expect(copy.x).toBeCloseTo(9.6952);
    expect(copy.y).toBe(10);
    expect(
      original.obstructions.every((item) => !rectanglesOverlap(copy, item)),
    ).toBe(true);
    expect(
      original.walls.every((wall) => !wallIntersectsRectangle(wall, copy)),
    ).toBe(true);
    expect(buildingError(next)).toBeNull();
  });

  it("places edge copies inward without resizing the plan", () => {
    const original = fixture();
    Object.assign(original.obstructions[0]!, { x: 28, y: 19 });
    const next = duplicateObstruction(original, "object", "copy");
    expect(next.obstructions.at(-1)!.x).toBeCloseTo(25.6952);
    expect(next.obstructions.at(-1)!.y).toBe(19);
    expect([next.width, next.height]).toEqual([30, 20]);
    expect(buildingError(next)).toBeNull();
  });

  it("handles long Unicode names within the shared 80-character limit", () => {
    const original = fixture();
    original.obstructions[0]!.name = "🪑".repeat(80);
    const first = duplicateObstruction(original, "object", "copy-1");
    const next = duplicateObstruction(first, "object", "copy-2");
    const names = next.obstructions.map((item) => item.name!);
    expect(new Set(names).size).toBe(3);
    for (const name of names) {
      expect([...name]).toHaveLength(80);
      expect(nameProblem(name)).toBeNull();
    }
    expect(buildingError(next)).toBeNull();
  });

  it("leaves missing objects unchanged and reports a full workspace without mutating it", () => {
    const original = fixture();
    expect(duplicateObstruction(original, "missing", "copy")).toBe(original);
    original.obstructions = [{ id: "full", x: 0, y: 0, width: 30, height: 20 }];
    const before = structuredClone(original);
    expect(() => duplicateObstruction(original, "full", "copy")).toThrow(
      "No valid nearby position",
    );
    expect(original).toEqual(before);
  });
});
describe("marquee and batch editing", () => {
  it("selects all six supported kinds only with full footprint containment, without changing data", () => {
    const b = fixture(),
      before = JSON.stringify(b);
    expect(
      marqueeSelection(b, { x: 0, y: 0, width: 30, height: 20 }),
    ).toHaveLength(6);
    expect(marqueeSelection(b, { x: 2, y: 2, width: 18, height: 0.1 })).toEqual(
      [],
    );
    expect(
      marqueeSelection(b, { x: 4.9, y: 4.9, width: 2.2, height: 2.2 }),
    ).toEqual([{ kind: "spawn_zones", id: "spawn" }]);
    expect(JSON.stringify(b)).toBe(before);
  });
  it("keeps additive/toggle selection unique and reversible", () => {
    const a: Selection = { kind: "walls", id: "wall" },
      c: Selection = { kind: "doors", id: "door" };
    expect(combineSelection([a], [a, c])).toEqual([a, c]);
    expect(toggleSelection([a], c)).toEqual([a, c]);
    expect(toggleSelection([a, c], a)).toEqual([c]);
  });
  it("moves selected walls and their openings once with stable references and population", () => {
    const b = fixture(),
      next = moveSelection(
        b,
        [
          { kind: "walls", id: "wall" },
          { kind: "doors", id: "door" },
          { kind: "spawn_zones", id: "spawn" },
        ],
        { x: 1, y: 2 },
      );
    expect(next.walls[0]!.start).toEqual({ x: 3, y: 4 });
    expect(next.doors).toEqual(b.doors);
    expect(next.exits).toEqual(b.exits);
    expect(next.spawn_zones[0]).toMatchObject({ x: 6, y: 7, count: 2 });
    expect(buildingError(next)).toBeNull();
    expect(b.walls[0]!.start).toEqual({ x: 2, y: 2 });
  });
  it("rejects out-of-bounds batches before mutation and projects independent openings along angled walls", () => {
    const b = fixture(),
      items: Selection[] = [
        { kind: "walls", id: "wall" },
        { kind: "obstructions", id: "object" },
      ];
    expect(
      buildingError(moveSelection(b, items, { x: 100, y: 100 }), false),
    ).not.toBeNull();
    expect(b.obstructions[0]!.x).toBe(12);
    b.walls[0]!.end = { x: 20, y: 11 };
    const moved = moveSelection(b, [{ kind: "doors", id: "door" }], {
      x: 2,
      y: 1,
    });
    expect(moved.doors[0]!.offset).toBeGreaterThan(2);
    expect(moved.doors[0]!.wall_id).toBe("wall");
    expect(buildingError(moved, false)).toBeNull();
  });
  it("batch deletion cleans attached records/blocked exits and preserves unselected elements", () => {
    const b = fixture(),
      next = removeSelection(b, [
        { kind: "walls", id: "wall" },
        { kind: "doors", id: "door" },
        { kind: "stair_areas", id: "stair" },
      ]);
    expect(next.walls).toEqual([]);
    expect(next.doors).toEqual([]);
    expect(next.exits).toEqual([]);
    expect(next.blocked_exit_ids).toEqual([]);
    expect(next.stair_areas).toEqual([]);
    expect(next.spawn_zones).toEqual(b.spawn_zones);
    expect(next.obstructions).toEqual(b.obstructions);
  });
  it("resizes a connected perimeter with attached openings proportionally and stable IDs", () => {
    let b = fixture();
    b = {
      ...b,
      walls: [],
      doors: [],
      exits: [],
      spawn_zones: [],
      obstructions: [],
      stair_areas: [],
      blocked_exit_ids: [],
    };
    let id = 0;
    b = addWallShape(
      b,
      "wall-rectangle",
      { x: 3, y: 3 },
      { x: 15, y: 12 },
      () => `w${id++}`,
    );
    b.doors = [
      {
        id: "opening",
        name: "Entrance",
        wall_id: b.walls[0]!.id,
        offset: 3,
        width: 1,
      },
    ];
    const items: Selection[] = b.walls.map((w) => ({
      kind: "walls",
      id: w.id,
    }));
    const next = resizeSelection(b, items, 24, 12);
    expect(selectionBounds(next, items)).toEqual({
      x: 3,
      y: 3,
      width: 24,
      height: 12,
    });
    expect(next.doors[0]).toMatchObject({
      id: "opening",
      wall_id: "w0",
      name: "Entrance",
      offset: 6,
      width: 2,
    });
    for (let i = 0; i < 4; i++)
      expect(next.walls[i]!.end).toEqual(next.walls[(i + 1) % 4]!.start);
    expect(buildingError(next, false)).toBeNull();
    expect(JSON.parse(JSON.stringify(next))).toEqual(next);
  });
  it("persists walkable stair metadata with bounds/name/orientation validation and ordinary movement", () => {
    const b = fixture();
    expect(buildingError(b)).toBeNull();
    expect(JSON.parse(JSON.stringify(b))).toEqual(b);
    const moved = moveSelection(b, [{ kind: "stair_areas", id: "stair" }], {
      x: 1,
      y: 1,
    });
    expect(moved.stair_areas![0]).toMatchObject({
      id: "stair",
      name: "Main stair",
      x: 16,
      y: 6,
      orientation_degrees: 90,
    });
    for (const bad of [45, null, "90"]) {
      const copy = JSON.parse(JSON.stringify(b));
      copy.stair_areas[0].orientation_degrees = bad;
      expect(buildingError(copy, false)).not.toBeNull();
    }
    b.stair_areas![0]!.x = 30;
    expect(buildingError(b, false)).not.toBeNull();
  });
});

it("rotates the actual object footprint around its centre with stable identity and valid JSON", () => {
  const original = fixture();
  original.obstructions[0]!.name = "Conference table";
  const next = rotateObstruction(original, "object");
  expect(next.obstructions[0]).toEqual({
    id: "object",
    name: "Conference table",
    x: 12.5,
    y: 9.5,
    width: 1,
    height: 2,
  });
  expect(buildingError(JSON.parse(JSON.stringify(next)))).toBeNull();
  expect(rotateObstruction(next, "object")).toEqual(original);
  expect(original.obstructions[0]).toMatchObject({
    x: 12,
    y: 10,
    width: 2,
    height: 1,
  });
  expect(next.walls).toBe(original.walls);
  expect(next.spawn_zones).toBe(original.spawn_zones);
});

it("leaves square or missing objects unchanged and exposes invalid rotations to existing validation", () => {
  const b = fixture();
  expect(rotateObstruction(b, "missing")).toBe(b);
  b.obstructions[0]!.height = 2;
  expect(rotateObstruction(b, "object")).toBe(b);
  Object.assign(b.obstructions[0]!, { x: 0, y: 10, width: 1, height: 4 });
  expect(buildingError(b)).toBeNull();
  expect(buildingError(rotateObstruction(b, "object"))).not.toBeNull();
  expect(b.obstructions[0]!.x).toBe(0);
});

it("can marquee-select thick walls on the workspace edge using their visible footprint", () => {
  const b = fixture();
  b.walls[0]!.start = { x: 0, y: 0 };
  b.walls[0]!.end = { x: 20, y: 0 };
  expect(
    marqueeSelection(b, { x: 0, y: 0, width: 30, height: 20 }).some(
      (s) => s.id === "wall",
    ),
  ).toBe(true);
});
