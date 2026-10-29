import { expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import { buildingError } from "./geometry";
import { duplicateSelection } from "./duplication";
import { elementKinds } from "./selection";
import { openingStartsBlocked } from "./openingState";
import { roomFillGroup, roomFillZones } from "./roomFill";

function fixture(): BuildingScenario {
  return {
    ...structuredClone(example),
    width: 70,
    height: 45,
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
    windows: [
      {
        id: "window",
        wall_id: "wall",
        offset: 6,
        width: 1.4,
        emergency_escape: {
          enabled: true,
          preparation: "open",
          clear_width_metres: 1.2,
          clear_height_metres: 1.2,
          preparation_seconds: 2,
          traversal_seconds: 3,
          exterior_side: 1,
          exterior_available: true,
        },
      },
    ],
    spawn_zones: [
      {
        id: "spawn",
        name: "Classroom",
        x: 5,
        y: 5,
        width: 2,
        height: 2,
        count: 2,
      },
    ],
    placed_occupants: [{ id: "person", x: 35, y: 35 }],
    obstructions: [
      { id: "object", name: "Desk", x: 12, y: 10, width: 2, height: 1 },
    ],
    stair_areas: [
      {
        id: "stairs",
        x: 20,
        y: 10,
        width: 2,
        height: 3,
        orientation_degrees: 90,
      },
    ],
    tornado_zones: [{ id: "shelter", x: 25, y: 15, width: 3, height: 3 }],
    blocked_exit_ids: ["exit"],
    opening_events: [
      { step: 0, opening_id: "door", blocked: true },
      { step: 5, opening_id: "exit", blocked: false },
      { step: 10, opening_id: "door", blocked: false },
    ],
  };
}
function ids() {
  let id = 0;
  return (kind: string) => `copy_${kind}_${++id}`;
}

it.each(elementKinds)(
  "duplicates %s with valid geometry, fresh identity and JSON",
  (kind) => {
    const original = fixture(),
      before = structuredClone(original),
      source = original[kind]![0]!;
    const edit = duplicateSelection(original, [{ kind, id: source.id }], ids());
    const copy = edit.building[kind]!.find(
      (v) => v.id === edit.ids.get(source.id),
    )!;
    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toContain("(copy)");
    expect(edit.selections).toEqual([{ kind, id: copy.id }]);
    expect(buildingError(edit.building)).toBeNull();
    expect(JSON.parse(JSON.stringify(edit.building))).toEqual(edit.building);
    expect(original).toEqual(before);
  },
);

it("copies a wall and all its attached openings exactly once, preserving blocked states, schedules and window configuration", () => {
  const original = fixture();
  const edit = duplicateSelection(
    original,
    [
      { kind: "walls", id: "wall" },
      { kind: "doors", id: "door" },
    ],
    ids(),
  );
  expect(edit.ids.size).toBe(4);
  expect(edit.building.walls).toHaveLength(2);
  expect(edit.building.doors).toHaveLength(2);
  for (const kind of ["doors", "exits", "windows"] as const) {
    const source = original[kind]![0]!,
      copy = edit.building[kind]![1]!;
    expect(copy).toMatchObject({
      id: edit.ids.get(source.id),
      wall_id: edit.ids.get("wall"),
      width: source.width,
      offset: source.offset,
    });
  }
  expect(openingStartsBlocked(edit.building, edit.ids.get("door")!)).toBe(true);
  expect(openingStartsBlocked(edit.building, edit.ids.get("exit")!)).toBe(true);
  expect(edit.building.opening_events).toHaveLength(6);
  expect(edit.building.opening_events!.map((v) => v.step)).toEqual([
    0, 0, 5, 5, 10, 10,
  ]);
  expect(edit.building.windows![1]!.emergency_escape).toEqual(
    original.windows![0]!.emergency_escape,
  );
  expect(edit.building.windows![1]!.emergency_escape).not.toBe(
    original.windows![0]!.emergency_escape,
  );
  expect(buildingError(edit.building)).toBeNull();
});

it.each([false, true])(
  "slides standalone openings along their original wall without overlapping other opening types (angled=%s)",
  (angled) => {
    const original = fixture();
    if (angled) original.walls[0]!.end = { x: 20, y: 20 };
    const edit = duplicateSelection(
      original,
      [{ kind: "doors", id: "door" }],
      ids(),
    );
    expect(edit.building.walls).toBe(original.walls);
    const copy = edit.building.doors[1]!;
    expect(copy.wall_id).toBe("wall");
    expect(copy.width).toBe(1);
    expect(copy.offset + copy.width <= 2 || copy.offset >= 3).toBe(true);
    expect(openingStartsBlocked(edit.building, copy.id)).toBe(true);
    expect(buildingError(edit.building)).toBeNull();
  },
);

it("duplicates mixed selections with one shared translation and independent parent references", () => {
  const original = fixture();
  const selections = elementKinds.map((kind) => ({
    kind,
    id: original[kind]![0]!.id,
  }));
  const edit = duplicateSelection(original, selections, ids());
  expect(edit.ids.size).toBe(9);
  expect(edit.selections).toHaveLength(9);
  const delta = {
    x: edit.building.walls[1]!.start.x - original.walls[0]!.start.x,
    y: edit.building.walls[1]!.start.y - original.walls[0]!.start.y,
  };
  for (const kind of [
    "spawn_zones",
    "obstructions",
    "stair_areas",
    "tornado_zones",
  ] as const) {
    const source = original[kind]![0]!,
      copy = edit.building[kind]![1]!;
    expect(copy.x - source.x).toBeCloseTo(delta.x);
    expect(copy.y - source.y).toBeCloseTo(delta.y);
    expect(copy.width).toBe(source.width);
    expect(copy.height).toBe(source.height);
  }
  expect(edit.building.spawn_zones[1]!.count).toBe(2);
  expect(edit.building.stair_areas![1]!.orientation_degrees).toBe(90);
  expect(buildingError(edit.building)).toBeNull();
});

it("keeps copied Fill Room areas together in a new, independent persistent group", () => {
  const original = fixture();
  original.spawn_zones = [
    { id: "roomfill_original_0", x: 5, y: 5, width: 2, height: 2, count: 2 },
    { id: "roomfill_original_1", x: 8, y: 5, width: 2, height: 2, count: 3 },
  ];
  const edit = duplicateSelection(
    original,
    [{ kind: "spawn_zones", id: "roomfill_original_0" }],
    ids(),
  );
  const copy = edit.building.spawn_zones[2]!;
  expect(edit.selections).toHaveLength(2);
  expect(roomFillGroup(copy.id)).not.toBe("original");
  expect(roomFillZones(edit.building, copy.id).map((v) => v.count)).toEqual([
    2, 3,
  ]);
  expect(roomFillZones(edit.building, original.spawn_zones[0]!.id)).toEqual(
    original.spawn_zones,
  );
  expect(buildingError(JSON.parse(JSON.stringify(edit.building)))).toBeNull();
});

it("rejects an opening with no available wall interval and leaves original IDs and data intact", () => {
  const original = fixture();
  original.walls[0]!.end = { x: 4, y: 2 };
  original.doors = [{ id: "door", wall_id: "wall", offset: 0, width: 2 }];
  original.exits = [];
  original.windows = [];
  original.blocked_exit_ids = [];
  original.opening_events = [];
  const before = structuredClone(original);
  expect(() =>
    duplicateSelection(original, [{ kind: "doors", id: "door" }], ids()),
  ).toThrow("No valid nearby position");
  expect(original).toEqual(before);
  expect(duplicateSelection(original, [], ids()).building).toBe(original);
});
