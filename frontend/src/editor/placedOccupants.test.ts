import { expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import { totalPopulation } from "../utils/population";
import { buildingError, translateElement } from "./geometry";
import { renameObject } from "./names";
import { duplicateSelection } from "./duplication";
import {
  canResizeSelection,
  marqueeSelection,
  moveSelection,
  removeSelection,
} from "./selection";

function fixture(): BuildingScenario {
  return {
    ...structuredClone(example),
    walls: [
      {
        id: "wall",
        start: { x: 1, y: 1 },
        end: { x: 29, y: 1 },
        thickness: 0.2,
      },
    ],
    doors: [],
    exits: [{ id: "exit", wall_id: "wall", offset: 3, width: 2 }],
    spawn_zones: [],
    obstructions: [],
    blocked_exit_ids: [],
    placed_occupants: [{ id: "person", name: "Reception", x: 5, y: 5 }],
  };
}
const selected = { kind: "placed_occupants" as const, id: "person" };

it("supports exact-only drafts and simulation inputs, with names and stable editor IDs through JSON", () => {
  const building = fixture();
  expect(buildingError(building)).toBeNull();
  expect(totalPopulation(building)).toBe(1);
  const moved = moveSelection(
    renameObject(building, selected, "Front desk"),
    [selected],
    { x: 0.125, y: 0.625 },
  );
  expect(moved.placed_occupants![0]).toEqual({
    id: "person",
    name: "Front desk",
    x: 5.125,
    y: 5.625,
  });
  expect(JSON.parse(JSON.stringify(moved))).toEqual(moved);
  expect(buildingError(moved)).toBeNull();
  expect(building.placed_occupants![0]!.x).toBe(5);
  expect(canResizeSelection(building, [selected])).toBe(false);
  expect(removeSelection(building, [selected]).placed_occupants).toEqual([]);
});

it("selects the full body, moves and duplicates it without adding size fields", () => {
  const building = fixture();
  expect(
    marqueeSelection(building, { x: 4, y: 4, width: 2, height: 2 }),
  ).toEqual([selected]);
  expect(
    marqueeSelection(building, { x: 5, y: 5, width: 1, height: 1 }),
  ).toEqual([]);
  const next = duplicateSelection(building, [selected], () => "copy").building;
  expect(next.placed_occupants).toHaveLength(2);
  expect(next.placed_occupants![1]).not.toHaveProperty("width");
  expect(buildingError(next)).toBeNull();
  expect(
    translateElement(building, selected, { x: -100, y: -100 })
      .placed_occupants![0],
  ).toMatchObject({ x: building.agent_radius, y: building.agent_radius });
});

it.each([
  "body outside",
  "furniture",
  "wall",
  "other occupant",
  "duplicate ID",
  "blank name",
])("rejects %s without changing valid data", (kind) => {
  const building = fixture();
  if (kind === "body outside") building.placed_occupants![0]!.x = 0.1;
  if (kind === "furniture")
    building.obstructions = [{ id: "desk", x: 4, y: 4, width: 2, height: 2 }];
  if (kind === "wall") {
    building.placed_occupants![0]!.x = 8;
    building.placed_occupants![0]!.y = 1.1;
  }
  if (kind === "other occupant")
    building.placed_occupants!.push({ id: "another", x: 5.1, y: 5 });
  if (kind === "duplicate ID") building.placed_occupants![0]!.id = "wall";
  if (kind === "blank name") building.placed_occupants![0]!.name = " ";
  expect(buildingError(building)).not.toBeNull();
});

it("uses the same initial open/closed aperture and solid-window rules as Rust", () => {
  const building = fixture();
  building.doors = [{ id: "door", wall_id: "wall", offset: 10, width: 2 }];
  building.placed_occupants = [{ id: "person", x: 12, y: 1 }];
  expect(buildingError(building)).toBeNull();
  building.opening_events = [{ step: 0, opening_id: "door", blocked: true }];
  expect(buildingError(building)).toContain("clearance");
  building.opening_events = [];
  building.doors = [];
  building.windows = [{ id: "window", wall_id: "wall", offset: 10, width: 2 }];
  expect(buildingError(building)).toContain("clearance");
});

it("counts both sources without forbidding exact centres inside sampled areas", () => {
  const building = fixture();
  building.spawn_zones = [
    { id: "area", x: 4, y: 4, width: 3, height: 3, count: 2 },
  ];
  expect(totalPopulation(building)).toBe(3);
  expect(buildingError(building)).toBeNull();
  building.spawn_zones = [
    { id: "area", x: 2, y: 2, width: 25, height: 15, count: 10000 },
  ];
  building.agent_radius = 0.01;
  expect(buildingError(building)).toContain("10,000");
  const legacy = { ...building, placed_occupants: undefined };
  expect(totalPopulation(legacy)).toBe(10000);
});
