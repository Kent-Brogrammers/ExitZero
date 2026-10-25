import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import {
  buildingError,
  removeElement,
  translateElement,
  wallLength,
} from "./geometry";
import {
  addObject,
  addSpawnZone,
  addWallShape,
  CIRCLE_WALL_SEGMENTS,
  dragRectangle,
  wallShapePoints,
} from "./shapes";

function draft(): BuildingScenario {
  return {
    ...structuredClone(example),
    walls: [],
    doors: [],
    exits: [],
    spawn_zones: [],
    obstructions: [],
    blocked_exit_ids: [],
  };
}
function ids() {
  let i = 0;
  return () => `new_${i++}`;
}

describe("drawn rectangular spawn areas", () => {
  it.each([false, true])(
    "uses the drag bounds and preserves names, counts and JSON (reverse=%s)",
    (reverse) => {
      const original = draft();
      const [start, end] = reverse
        ? [
            { x: 10, y: 7 },
            { x: 2, y: 3 },
          ]
        : [
            { x: 2, y: 3 },
            { x: 10, y: 7 },
          ];
      const next = addSpawnZone(original, start!, end!, false, "spawn-one");
      expect(next.spawn_zones).toEqual([
        {
          id: "spawn-one",
          name: "Spawn zone 1",
          x: 2,
          y: 3,
          width: 8,
          height: 4,
          count: 21,
        },
      ]);
      expect(buildingError(next, false)).toBeNull();
      expect(JSON.parse(JSON.stringify(next))).toEqual(next);
      expect(original.spawn_zones).toEqual([]);
    },
  );

  it("saves the same square as the Shift preview, constrained inside workspace edges", () => {
    const original = draft();
    const next = addSpawnZone(
      original,
      { x: 28, y: 18 },
      { x: 24, y: 17 },
      true,
      "square",
    );
    expect(next.spawn_zones[0]).toMatchObject({
      x: 24,
      y: 14,
      width: 4,
      height: 4,
    });
    expect(buildingError(next, false)).toBeNull();
  });

  it("caps the suggested population to the remaining shared limit and configured disc area", () => {
    const original = {
      ...draft(),
      width: 1000,
      height: 1000,
      spawn_zones: [
        { id: "existing", x: 1, y: 1, width: 200, height: 200, count: 9999 },
      ],
    };
    const next = addSpawnZone(
      original,
      { x: 250, y: 250 },
      { x: 270, y: 270 },
      false,
      "last",
    );
    expect(next.spawn_zones.at(-1)!.count).toBe(1);
    expect(buildingError(next, false)).toBeNull();
    const largeAgents = addSpawnZone(
      { ...draft(), agent_radius: 1.5 },
      { x: 2, y: 2 },
      { x: 5, y: 5 },
      false,
      "large",
    );
    expect(largeAgents.spawn_zones[0]!.count).toBe(1);
    expect(buildingError(largeAgents, false)).toBeNull();
  });

  it.each(["narrow", "wall", "obstruction", "spawn"])(
    "validates a %s footprint without modifying the original",
    (kind) => {
      const original = draft();
      if (kind === "wall")
        original.walls = [
          {
            id: "wall",
            start: { x: 4, y: 1 },
            end: { x: 4, y: 8 },
            thickness: 0.2,
          },
        ];
      if (kind === "obstruction")
        original.obstructions = [
          { id: "obstacle", x: 3, y: 3, width: 1, height: 1 },
        ];
      if (kind === "spawn")
        original.spawn_zones = [
          { id: "spawn", x: 3, y: 3, width: 1, height: 1, count: 1 },
        ];
      const before = structuredClone(original);
      const next = addSpawnZone(
        original,
        { x: 2, y: 2 },
        { x: kind === "narrow" ? 2.1 : 6, y: 6 },
        false,
        "new",
      );
      if (kind === "wall" || kind === "obstruction")
        expect(buildingError(next, false)).toBeNull();
      else expect(buildingError(next, false)).not.toBeNull();
      expect(original).toEqual(before);
    },
  );
});

describe("contract-compatible drawing shapes", () => {
  it.each([
    [
      { x: 3, y: 4 },
      { x: 12, y: 10 },
    ],
    [
      { x: 12, y: 10 },
      { x: 3, y: 4 },
    ],
  ])(
    "creates an exactly connected rectangle in either drag direction",
    (start, end) => {
      const original = draft(),
        next = addWallShape(original, "wall-rectangle", start, end, ids());
      expect(next.walls).toHaveLength(4);
      expect(new Set(next.walls.map((w) => w.id)).size).toBe(4);
      expect(next.walls.map((w) => w.name)).toEqual([
        "Wall 1",
        "Wall 2",
        "Wall 3",
        "Wall 4",
      ]);
      for (const [i, wall] of next.walls.entries()) {
        expect(wall.end).toEqual(next.walls[(i + 1) % 4]!.start);
        expect(wallLength(wall)).toBeGreaterThan(0.1);
      }
      expect(next.walls[0]!.start).toEqual({ x: 3, y: 4 });
      expect(buildingError(next, false)).toBeNull();
      expect(JSON.parse(JSON.stringify(next))).toEqual(next);
      expect(original.walls).toHaveLength(0);
    },
  );
  it("keeps arbitrary angled straight walls unchanged by the shape helper", () => {
    const next = addWallShape(
      draft(),
      "wall",
      { x: 2.3, y: 4.5 },
      { x: 8.7, y: 12.2 },
      ids(),
    );
    expect(next.walls).toHaveLength(1);
    expect(next.walls[0]!.start).toEqual({ x: 2.3, y: 4.5 });
    expect(next.walls[0]!.end).toEqual({ x: 8.7, y: 12.2 });
    expect(buildingError(next, false)).toBeNull();
  });
  it("saves a circular perimeter honestly as 32 connected straight walls", () => {
    const original = draft(),
      next = addWallShape(
        original,
        "wall-circle",
        { x: 11, y: 6 },
        { x: 19, y: 14 },
        ids(),
      );
    expect(next.walls).toHaveLength(CIRCLE_WALL_SEGMENTS);
    for (const [i, wall] of next.walls.entries()) {
      expect(wall.end).toEqual(
        next.walls[(i + 1) % CIRCLE_WALL_SEGMENTS]!.start,
      );
      expect(Math.hypot(wall.start.x - 15, wall.start.y - 10)).toBeCloseTo(4);
      expect(wallLength(wall)).toBeCloseTo(
        8 * Math.sin(Math.PI / CIRCLE_WALL_SEGMENTS),
      );
      expect(Object.keys(wall).sort()).toEqual([
        "end",
        "id",
        "name",
        "start",
        "thickness",
      ]);
    }
    expect(buildingError(next, false)).toBeNull();
    expect(JSON.parse(JSON.stringify(next))).toEqual(next);
    expect(original.walls).toHaveLength(0);
  });
  it("uses identical bounding ellipse vertices for preview and persistence with independent radii", () => {
    const b = draft(),
      start = { x: 2, y: 3 },
      end = { x: 20, y: 9 };
    const points = wallShapePoints("wall-circle", start, end, b),
      next = addWallShape(b, "wall-circle", start, end, ids());
    expect(next.walls.map((w) => w.start)).toEqual(points.slice(0, -1));
    expect(Math.max(...points.map((p) => p.x))).toBeCloseTo(20);
    expect(Math.min(...points.map((p) => p.y))).toBeCloseTo(3);
    expect(Math.max(...points.map((p) => p.y))).toBeCloseTo(9);
    expect(buildingError(next, false)).toBeNull();
  });
  it("constrains perimeters only when Shift is requested", () => {
    const b = draft();
    const free = wallShapePoints(
      "wall-rectangle",
      { x: 2, y: 2 },
      { x: 10, y: 5 },
      b,
    );
    expect(free[2]).toEqual({ x: 10, y: 5 });
    const square = wallShapePoints(
      "wall-rectangle",
      { x: 2, y: 2 },
      { x: 10, y: 5 },
      b,
      true,
    );
    expect(square[2]).toEqual({ x: 10, y: 10 });
    const circle = wallShapePoints(
      "wall-circle",
      { x: 2, y: 2 },
      { x: 10, y: 5 },
      b,
      true,
    );
    expect(
      Math.max(...circle.map((p) => p.x)) - Math.min(...circle.map((p) => p.x)),
    ).toBeCloseTo(
      Math.max(...circle.map((p) => p.y)) - Math.min(...circle.map((p) => p.y)),
    );
  });
  it.each(["wall-rectangle", "wall-circle"] as const)(
    "rejects degenerate %s and preserves the original draft",
    (shape) => {
      const original = draft();
      const invalid = addWallShape(
        original,
        shape,
        { x: 5, y: 5 },
        { x: 5.01, y: 5 },
        ids(),
      );
      expect(buildingError(invalid, false)).not.toBeNull();
      expect(original.walls).toHaveLength(0);
    },
  );
  it("uses the existing wall limit for an entire perimeter, without partially mutating the building", () => {
    const b = draft();
    b.walls = Array.from({ length: 480 }, (_, i) => ({
      id: `existing_${i}`,
      start: { x: 0, y: 0 },
      end: { x: 1, y: 0 },
      thickness: 0.2,
    }));
    expect(
      buildingError(
        addWallShape(
          b,
          "wall-circle",
          { x: 15, y: 10 },
          { x: 19, y: 10 },
          ids(),
        ),
        false,
      ),
    ).not.toBeNull();
    expect(b.walls).toHaveLength(480);
  });
  it("retains ordinary opening references and segment deletion cleanup", () => {
    const b = addWallShape(
      draft(),
      "wall-rectangle",
      { x: 3, y: 3 },
      { x: 12, y: 12 },
      ids(),
    );
    b.doors = [
      {
        id: "door",
        name: "Main Entrance",
        wall_id: b.walls[0]!.id,
        offset: 2,
        width: 1,
      },
    ];
    b.exits = [{ id: "exit", wall_id: b.walls[1]!.id, offset: 2, width: 1 }];
    b.blocked_exit_ids = ["exit"];
    expect(buildingError(b, false)).toBeNull();
    const moved = translateElement(
      b,
      { kind: "walls", id: b.walls[0]!.id },
      { x: 0, y: 0.5 },
    );
    expect(moved.doors).toEqual(b.doors);
    const removed = removeElement(b, { kind: "walls", id: b.walls[1]!.id });
    expect(removed.walls).toHaveLength(3);
    expect(removed.exits).toHaveLength(0);
    expect(removed.blocked_exit_ids).toEqual([]);
    expect(removed.doors).toEqual(b.doors);
    expect(buildingError(removed, false)).toBeNull();
  });
  it.each([false, true])(
    "creates generic objects with stable IDs, names, and schema-supported rectangle fields (square=%s)",
    (square) => {
      const original = draft(),
        next = addObject(
          original,
          { x: 3, y: 4 },
          { x: 8, y: 6 },
          square,
          "object-stable",
        );
      const object = next.obstructions[0]!;
      expect(object).toEqual({
        id: "object-stable",
        name: "Object 1",
        x: 3,
        y: 4,
        width: 5,
        height: square ? 5 : 2,
      });
      expect(buildingError(next, false)).toBeNull();
      expect(JSON.parse(JSON.stringify(next))).toEqual(next);
      expect(original.obstructions).toHaveLength(0);
    },
  );
  it("constrains reverse square drags at workspace edges without losing equal sides", () => {
    expect(
      dragRectangle({ x: 2, y: 4 }, { x: 0, y: 0 }, draft(), true),
    ).toEqual({ x: 0, y: 2, width: 2, height: 2 });
    const b = addObject(
      draft(),
      { x: 29, y: 18 },
      { x: 30, y: 20 },
      true,
      "square",
    );
    expect(b.obstructions[0]).toMatchObject({
      x: 29,
      y: 18,
      width: 1,
      height: 1,
    });
    expect(buildingError(b, false)).toBeNull();
  });
  it("allows spawn areas to cover objects and wall perimeters", () => {
    const b = draft();
    b.spawn_zones = [
      { id: "spawn", x: 5, y: 5, width: 2, height: 2, count: 1 },
    ];
    expect(
      buildingError(
        addObject(b, { x: 5, y: 5 }, { x: 6, y: 6 }, false, "object"),
        false,
      ),
    ).toBeNull();
    expect(
      buildingError(
        addWallShape(
          b,
          "wall-rectangle",
          { x: 4, y: 6 },
          { x: 8, y: 9 },
          ids(),
        ),
        false,
      ),
    ).toBeNull();
  });
});
