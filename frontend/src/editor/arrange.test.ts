import { expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import { buildingError, type Selection } from "./geometry";
import {
  arrangeProblem,
  arrangeSelection,
  type ArrangeAction,
} from "./arrange";

function fixture(): BuildingScenario {
  return {
    ...structuredClone(example),
    walls: [
      {
        id: "wall",
        start: { x: 0, y: 0 },
        end: { x: 30, y: 0 },
        thickness: 0.2,
      },
    ],
    doors: [],
    windows: [],
    exits: [{ id: "exit", wall_id: "wall", offset: 28, width: 1 }],
    spawn_zones: [{ id: "spawn", x: 2, y: 3, width: 1, height: 1, count: 1 }],
    obstructions: [
      { id: "a", name: "Desk A", x: 6, y: 5, width: 2, height: 1 },
      { id: "b", name: "Desk B", x: 12, y: 10, width: 1, height: 3 },
      { id: "c", name: "Desk C", x: 20, y: 14, width: 3, height: 2 },
    ],
    blocked_exit_ids: ["exit"],
    opening_events: [{ step: 7, opening_id: "exit", blocked: false }],
  };
}
const selected: Selection[] = ["a", "b", "c"].map((id) => ({
  kind: "obstructions",
  id,
}));

it.each([
  ["left", "x", "width", 6],
  ["center-x", "x", "width", 14.5],
  ["right", "x", "width", 23],
  ["top", "y", "height", 5],
  ["center-y", "y", "height", 10.5],
  ["bottom", "y", "height", 16],
] as const)(
  "%s uses selection bounds without resizing or changing references",
  (action, axis, size, target) => {
    const building = fixture(),
      before = JSON.stringify(building);
    expect(buildingError(building)).toBeNull();
    const result = arrangeSelection(building, selected, action);
    expect(result.error).toBeNull();
    expect(result.changed).toBe(true);
    for (const [index, item] of result.building.obstructions.entries()) {
      const position =
        item[axis] +
        (action.startsWith("center")
          ? item[size] / 2
          : ["right", "bottom"].includes(action)
            ? item[size]
            : 0);
      expect(position).toBeCloseTo(target);
      expect(item.width).toBe(building.obstructions[index]!.width);
      expect(item.height).toBe(building.obstructions[index]!.height);
      expect(item.name).toBe(building.obstructions[index]!.name);
    }
    for (const key of [
      "walls",
      "doors",
      "exits",
      "windows",
      "blocked_exit_ids",
      "opening_events",
      "spawn_zones",
    ] as const)
      expect(result.building[key]).toEqual(building[key]);
    expect(JSON.stringify(building)).toBe(before);
    expect(JSON.parse(JSON.stringify(result.building))).toEqual(
      result.building,
    );
  },
);

it.each([
  ["gap-x", "x", 5.5, 13.5],
  ["gap-y", "y", 2.5, 8.5],
] as const)(
  "%s distributes edge gaps for unequal sizes with fixed endpoints",
  (action, axis, gap, position) => {
    const building = fixture();
    const result = arrangeSelection(building, [...selected].reverse(), action);
    expect(result.error).toBeNull();
    expect(result.gap).toBe(gap);
    expect(result.building.obstructions[0]).toEqual(building.obstructions[0]);
    expect(result.building.obstructions[2]).toEqual(building.obstructions[2]);
    expect(result.building.obstructions[1]![axis]).toBe(position);
    expect(arrangeSelection(result.building, selected, action)).toMatchObject({
      changed: false,
      error: null,
    });
  },
);

it("allows touching footprints but refuses negative equal gaps without moving anything", () => {
  const building = fixture();
  building.obstructions = [
    { id: "a", x: 1, y: 5, width: 2, height: 1 },
    { id: "b", x: 2, y: 5, width: 3, height: 1 },
    { id: "c", x: 6, y: 5, width: 1, height: 1 },
  ];
  const touching = arrangeSelection(building, selected, "gap-x");
  expect(touching.gap).toBe(0);
  expect(touching.error).toBeNull();
  expect(touching.building.obstructions[1]!.x).toBe(3);
  building.obstructions[2]!.x = 5;
  const invalid = arrangeSelection(building, selected, "gap-x");
  expect(invalid.error).toMatch(/not enough space/i);
  expect(invalid.building).toBe(building);
  expect(invalid.changed).toBe(false);
});

it("moves polygon vertices and holes with the footprint, preserving counts and metadata", () => {
  const building = fixture();
  building.spawn_zones = [
    {
      id: "polygon",
      name: "Classroom",
      x: 2,
      y: 3,
      width: 4,
      height: 4,
      count: 2,
      polygon: [
        { x: 2, y: 3 },
        { x: 6, y: 3 },
        { x: 6, y: 7 },
        { x: 2, y: 7 },
      ],
      holes: [
        [
          { x: 3, y: 4 },
          { x: 4, y: 4 },
          { x: 4, y: 5 },
          { x: 3, y: 5 },
        ],
      ],
    },
  ];
  const result = arrangeSelection(
    building,
    [{ kind: "spawn_zones", id: "polygon" }, selected[1]!],
    "right",
  );
  expect(result.error).toBeNull();
  expect(result.building.spawn_zones[0]).toMatchObject({
    id: "polygon",
    name: "Classroom",
    x: 9,
    y: 3,
    width: 4,
    height: 4,
    count: 2,
  });
  expect(result.building.spawn_zones[0]!.polygon![0]).toEqual({ x: 9, y: 3 });
  expect(result.building.spawn_zones[0]!.holes![0]![0]).toEqual({
    x: 10,
    y: 4,
  });
  expect(building.spawn_zones[0]!.x).toBe(2);
});

it("supports mixed zones and stairs without changing orientation or shelter capacity", () => {
  const building = fixture();
  building.stair_areas = [
    { id: "stairs", x: 8, y: 8, width: 2, height: 3, orientation_degrees: 90 },
  ];
  building.tornado_zones = [
    { id: "shelter", x: 20, y: 13, width: 2, height: 2, max_occupants: 12 },
  ];
  const result = arrangeSelection(
    building,
    [
      selected[0]!,
      { kind: "stair_areas", id: "stairs" },
      { kind: "tornado_zones", id: "shelter" },
    ],
    "top",
  );
  expect(result.error).toBeNull();
  expect(result.building.stair_areas![0]).toMatchObject({
    y: 5,
    orientation_degrees: 90,
    width: 2,
    height: 3,
  });
  expect(result.building.tornado_zones![0]).toMatchObject({
    y: 5,
    max_occupants: 12,
  });
});

it("reports actual validation failures without mutating the source", () => {
  const building = fixture();
  building.spawn_zones = [
    { id: "one", x: 6, y: 5, width: 4, height: 2, count: 1 },
    { id: "two", x: 8, y: 8, width: 4, height: 2, count: 1 },
  ];
  const before = JSON.stringify(building);
  const result = arrangeSelection(
    building,
    [
      { kind: "spawn_zones", id: "one" },
      { kind: "spawn_zones", id: "two" },
    ],
    "top",
  );
  expect(result.error).toMatch(/overlap/i);
  expect(JSON.stringify(building)).toBe(before);
});

it("rejects a blocker moved onto an exact occupant using existing geometry validation", () => {
  const building = fixture();
  building.placed_occupants = [{ id: "person", x: 6.5, y: 11 }];
  expect(buildingError(building)).toBeNull();
  const before = JSON.stringify(building);
  const result = arrangeSelection(building, selected, "left");
  expect(result.error).toBeTruthy();
  expect(result.building.placed_occupants).toEqual(building.placed_occupants);
  expect(JSON.stringify(building)).toBe(before);
});

it("rejects unsupported, incomplete, duplicate, or stale selections instead of silently moving part of a group", () => {
  const building = fixture();
  expect(arrangeProblem(building, [selected[0]!])).toMatch(/at least two/i);
  for (const kind of [
    "walls",
    "doors",
    "exits",
    "windows",
    "placed_occupants",
  ] as const) {
    const result = arrangeSelection(
      building,
      [selected[0]!, { kind, id: "wall" }],
      "left",
    );
    expect(result.error).toMatch(/deselect walls/i);
    expect(result.building).toBe(building);
  }
  expect(arrangeProblem(building, [selected[0]!, selected[0]!])).toMatch(
    /changed/i,
  );
  expect(
    arrangeProblem(building, [
      selected[0]!,
      { kind: "obstructions", id: "missing" },
    ]),
  ).toMatch(/changed/i);
  expect(
    arrangeSelection(building, selected.slice(0, 2), "gap-x").error,
  ).toMatch(/three/i);
  const aligned = arrangeSelection(building, selected, "left").building;
  const repeated = arrangeSelection(aligned, selected, "left" as ArrangeAction);
  expect(repeated.building).toBe(aligned);
  expect(repeated.changed).toBe(false);
});
