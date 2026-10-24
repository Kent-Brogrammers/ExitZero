import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import schema from "../../../shared/schemas/contracts.schema.json";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import {
  applyCellTool,
  cellsAlongStroke,
  pointerToCell,
  resizeBuilding,
} from "./editing";

function fixture(): BuildingScenario {
  return {
    width: 6,
    height: 5,
    walls: [{ x: 3, y: 2 }],
    doors: [],
    exits: [
      { id: "west", x: 0, y: 2 },
      { id: "east", x: 5, y: 2 },
    ],
    spawn_zones: [{ x: 1, y: 1, width: 2, height: 2, count: 3 }],
    blocked_exit_ids: [],
    blocked_cells: [],
    seed: 42,
    max_steps: 1000,
  };
}

const bounds = { left: 100, top: 50, width: 300, height: 200 };

describe("pointer cell selection", () => {
  it("maps the top-left origin and CSS-scaled cells independently of display density", () => {
    expect(pointerToCell(100, 50, bounds, fixture())).toEqual({ x: 0, y: 0 });
    expect(pointerToCell(275, 150, bounds, fixture())).toEqual({ x: 3, y: 2 });
    expect(pointerToCell(399.9, 249.9, bounds, fixture())).toEqual({
      x: 5,
      y: 4,
    });
    expect(pointerToCell(200, 90, bounds, fixture())).toEqual({ x: 2, y: 1 });
    expect(
      pointerToCell(
        450,
        250,
        { ...bounds, width: 600, height: 400 },
        fixture(),
      ),
    ).toEqual({ x: 3, y: 2 });
  });

  it.each([
    [99, 50],
    [100, 49],
    [400, 150],
    [200, 250],
    [NaN, 50],
  ])("ignores points outside the canvas (%s, %s)", (x, y) => {
    expect(pointerToCell(x, y, bounds, fixture())).toBeNull();
  });

  it("ignores an unmeasured canvas", () => {
    expect(
      pointerToCell(100, 50, { ...bounds, width: 0 }, fixture()),
    ).toBeNull();
  });

  it("fills cells skipped by a fast drag in either direction", () => {
    const expected = [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ];
    expect(cellsAlongStroke(expected[0]!, expected[3]!)).toEqual(expected);
    expect(cellsAlongStroke(expected[3]!, expected[0]!)).toEqual(
      [...expected].reverse(),
    );
    expect(cellsAlongStroke({ x: 1, y: 1 }, { x: 3, y: 3 })).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]);
  });
});

describe("building editing", () => {
  it("places walls once and removes them with erase or walkable", () => {
    const original = fixture();
    const cell = { x: 4, y: 1 };
    const placed = applyCellTool(original, cell, "wall");
    expect(placed.error).toBeNull();
    expect(placed.building.walls).toContainEqual(cell);
    expect(
      applyCellTool(placed.building, cell, "wall").building.walls,
    ).toHaveLength(2);
    for (const tool of ["erase", "walkable"] as const) {
      expect(
        applyCellTool(placed.building, cell, tool).building.walls,
      ).not.toContainEqual(cell);
    }
    expect(original.walls).toEqual([{ x: 3, y: 2 }]);
  });

  it("replaces a wall with a walkable door, then replaces that door with a wall", () => {
    const cell = { x: 3, y: 2 };
    const door = applyCellTool(fixture(), cell, "door").building;
    expect(door.walls).not.toContainEqual(cell);
    expect(door.doors).toEqual([cell]);
    const wall = applyCellTool(door, cell, "wall").building;
    expect(wall.walls).toEqual([cell]);
    expect(wall.doors).toEqual([]);
    expect(applyCellTool(door, cell, "erase").building.doors).toEqual([]);
  });

  it("creates boundary exits by replacing a wall or a door without overlaps", () => {
    const cell = { x: 3, y: 0 };
    for (const tool of ["wall", "door"] as const) {
      const prepared = applyCellTool(fixture(), cell, tool).building;
      const result = applyCellTool(prepared, cell, "exit");
      expect(result.error).toBeNull();
      expect(result.building.exits).toContainEqual({ ...cell, id: "exit-3-0" });
      expect(result.building.walls).not.toContainEqual(cell);
      expect(result.building.doors).not.toContainEqual(cell);
    }
  });

  it("rejects interior exits without modifying the building", () => {
    const original = fixture();
    const result = applyCellTool(original, { x: 3, y: 2 }, "exit");
    expect(result.building).toBe(original);
    expect(result.error).toMatch(/boundary/);
  });

  it("uses unique exit IDs and preserves an existing exit when repainted", () => {
    const building = fixture();
    building.exits[0]!.id = "exit-3-0";
    const result = applyCellTool(building, { x: 3, y: 0 }, "exit").building;
    expect(result.exits[2]!.id).toBe("exit-3-0-2");
    expect(applyCellTool(result, { x: 3, y: 0 }, "exit").building).toBe(result);
    expect(new Set(result.exits.map((exit) => exit.id)).size).toBe(
      result.exits.length,
    );
  });

  it("removes references to deleted exits and never removes the last exit", () => {
    const building = fixture();
    building.blocked_exit_ids = ["west", "east"];
    const removed = applyCellTool(building, { x: 0, y: 2 }, "erase").building;
    expect(removed.exits).toEqual([{ id: "east", x: 5, y: 2 }]);
    expect(removed.blocked_exit_ids).toEqual(["east"]);
    for (const tool of ["erase", "walkable", "wall", "door"] as const) {
      const rejected = applyCellTool(removed, { x: 5, y: 2 }, tool);
      expect(rejected.building).toBe(removed);
      expect(rejected.error).toMatch(/at least one exit/);
    }
  });

  it("preserves spawn rectangles and counts and rejects walls or exits inside them", () => {
    const building = fixture();
    for (const tool of ["wall", "exit"] as const) {
      const rejected = applyCellTool(building, { x: 1, y: 1 }, tool);
      expect(rejected.error).toMatch(/Spawn zones/);
      expect(rejected.building).toBe(building);
    }
    for (const tool of ["walkable", "erase", "door"] as const) {
      const result = applyCellTool(building, { x: 1, y: 1 }, tool);
      expect(result.error).toBeNull();
      expect(result.building.spawn_zones).toBe(building.spawn_zones);
    }
  });

  it("requires clearing a blocked cell before placing geometry", () => {
    const building = fixture();
    const cell = { x: 4, y: 0 };
    building.blocked_cells = [cell];
    for (const tool of ["wall", "door", "exit"] as const) {
      expect(applyCellTool(building, cell, tool).error).toMatch(/blocked/);
    }
    for (const tool of ["walkable", "erase"] as const) {
      expect(
        applyCellTool(building, cell, tool).building.blocked_cells,
      ).toEqual([]);
    }
  });

  it.each([
    { x: -1, y: 0 },
    { x: 6, y: 0 },
    { x: 0, y: 5 },
    { x: 1.5, y: 1 },
  ])("rejects invalid cell coordinates %j", (cell) => {
    const building = fixture();
    expect(applyCellTool(building, cell, "wall").building).toBe(building);
    expect(applyCellTool(building, cell, "wall").error).toBeTruthy();
  });

  it("serializes an edited example with the existing JSON contract", () => {
    const original = structuredClone(example);
    let building: BuildingScenario = example;
    for (const [tool, cell] of [
      ["wall", { x: 10, y: 10 }],
      ["door", { x: 10, y: 10 }],
      ["exit", { x: 4, y: 0 }],
      ["erase", { x: 4, y: 0 }],
      ["walkable", { x: 10, y: 10 }],
    ] as const) {
      const edited = applyCellTool(building, cell, tool);
      expect(edited.error).toBeNull();
      building = edited.building;
    }
    const json: unknown = JSON.parse(JSON.stringify(building));
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(json), JSON.stringify(validate.errors)).toBe(true);
    expect(building.spawn_zones).toEqual(example.spawn_zones);
    expect(building.seed).toBe(example.seed);
    expect(building.max_steps).toBe(example.max_steps);
    expect(example).toEqual(original);
  });
});

describe("grid dimensions", () => {
  it("resizes without losing cells, occupants or boundary exits", () => {
    const building = fixture();
    building.exits = [{ id: "west", x: 0, y: 2 }];
    const result = resizeBuilding(building, 10, 8);
    expect(result.error).toBeNull();
    expect([result.building.width, result.building.height]).toEqual([10, 8]);
    expect(result.building.spawn_zones).toBe(building.spawn_zones);
    expect(building.width).toBe(6);
  });

  it.each([
    [0, 5],
    [513, 5],
    [6, 0],
    [6, 513],
    [3.5, 5],
    [NaN, 5],
  ])("rejects unsupported dimensions %s × %s", (width, height) => {
    const building = fixture();
    expect(resizeBuilding(building, width, height).building).toBe(building);
    expect(resizeBuilding(building, width, height).error).toMatch(/1 and 512/);
  });

  it("rejects cropping existing geometry or spawn rectangles", () => {
    const building = fixture();
    expect(resizeBuilding(building, 5, 5).error).toMatch(/remove existing/);
    building.exits = [{ id: "west", x: 0, y: 2 }];
    building.walls = [];
    expect(resizeBuilding(building, 2, 5).error).toMatch(/spawn zones/);
  });

  it("rejects moving existing exits off the boundary", () => {
    expect(resizeBuilding(fixture(), 7, 5).error).toMatch(/off the boundary/);
  });
});
