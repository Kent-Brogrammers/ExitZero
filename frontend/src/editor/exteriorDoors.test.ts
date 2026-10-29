import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type {
  BuildingScenario,
  Opening,
  Point,
  Wall,
} from "../types/simulation";
import { buildingError } from "./geometry";
import { isExteriorDoor, reclassifyDoors } from "./exteriorDoors";
import { openingStartsBlocked } from "./openingState";

function loop(id: string, points: Point[]): Wall[] {
  return points.map((start, index) => ({
    id: `${id}${index}`,
    start,
    end: points[(index + 1) % points.length]!,
    thickness: 0.2,
  }));
}
function room(): BuildingScenario {
  return {
    ...structuredClone(example),
    walls: loop("outer", [
      { x: 2, y: 2 },
      { x: 18, y: 2 },
      { x: 18, y: 14 },
      { x: 2, y: 14 },
    ]),
    doors: [],
    exits: [],
    windows: [],
    spawn_zones: [],
    obstructions: [],
    blocked_exit_ids: [],
  };
}
const door = (id: string, wall_id: string, offset = 2, width = 1): Opening => ({
  id,
  wall_id,
  offset,
  width,
  name: `Named ${id}`,
});

describe("automatic exterior door classification", () => {
  it("promotes perimeter doors and leaves internal doors across T joins ordinary", () => {
    const building = room();
    building.walls.push({
      id: "partition",
      start: { x: 10, y: 2 },
      end: { x: 10, y: 14 },
      thickness: 0.2,
    });
    building.doors = [door("north", "outer0"), door("inside", "partition")];
    const next = reclassifyDoors(building);
    expect(next.exits).toEqual([building.doors[0]]);
    expect(next.doors).toEqual([building.doors[1]]);
    expect(building.exits).toEqual([]);
    expect(buildingError(next, false)).toBeNull();
    expect(reclassifyDoors(next)).toBe(next);
  });

  it("uses enclosed walls rather than workspace edges and rejects unenclosed walls", () => {
    const building = room(),
      opening = door("north", "outer0");
    expect(isExteriorDoor(building, opening)).toBe(true);
    expect(
      isExteriorDoor(
        { ...building, walls: building.walls.slice(0, 3) },
        opening,
      ),
    ).toBe(false);
    expect(
      isExteriorDoor(
        {
          ...building,
          walls: [
            {
              id: "edge",
              start: { x: 0, y: 0 },
              end: { x: 30, y: 0 },
              thickness: 0.2,
            },
          ],
        },
        door("edge-door", "edge"),
      ),
    ).toBe(false);
  });

  it("recognizes angled and concave exterior segments in either wall direction", () => {
    const building = room();
    building.walls = loop("angle", [
      { x: 2, y: 4 },
      { x: 12, y: 2 },
      { x: 18, y: 8 },
      { x: 10, y: 7 },
      { x: 8, y: 14 },
    ]);
    for (const wall of building.walls)
      expect(isExteriorDoor(building, door("d", wall.id, 1))).toBe(true);
    const reversed = {
      ...building,
      walls: building.walls.map((wall) => ({
        ...wall,
        start: wall.end,
        end: wall.start,
      })),
    };
    for (const wall of reversed.walls)
      expect(isExteriorDoor(reversed, door("d", wall.id, 1))).toBe(true);
  });

  it("handles crossing partitions and only classifies the complete opening span", () => {
    const building = room();
    // This single parent wall crosses the room and extends outdoors at both ends.
    building.walls.push({
      id: "crossing",
      start: { x: 0, y: 8 },
      end: { x: 22, y: 8 },
      thickness: 0.2,
    });
    expect(isExteriorDoor(building, door("inside", "crossing", 4))).toBe(false);
    expect(isExteriorDoor(building, door("outside", "crossing", 19))).toBe(
      false,
    );
    expect(isExteriorDoor(building, door("perimeter", "outer1", 2))).toBe(true);
    expect(isExteriorDoor(building, door("overrun", "outer1", 11.5))).toBe(
      false,
    );
    expect(isExteriorDoor(building, door("missing", "absent"))).toBe(false);
  });

  it("recognizes disconnected buildings while keeping nested enclosures internal", () => {
    const building = room();
    building.walls.push(
      ...loop("inner", [
        { x: 6, y: 6 },
        { x: 12, y: 6 },
        { x: 12, y: 10 },
        { x: 6, y: 10 },
      ]),
      ...loop("other", [
        { x: 22, y: 2 },
        { x: 28, y: 2 },
        { x: 28, y: 10 },
        { x: 22, y: 10 },
      ]),
    );
    expect(isExteriorDoor(building, door("outer", "outer0"))).toBe(true);
    expect(isExteriorDoor(building, door("other", "other0"))).toBe(true);
    expect(isExteriorDoor(building, door("enclosed", "inner0"))).toBe(false);
  });

  it("keeps an exterior-facing branch wall ordinary and rejects a mixed span", () => {
    const building = room();
    building.walls[0] = {
      ...building.walls[0]!,
      start: { x: 0, y: 2 },
    };
    building.walls.push({
      id: "twig",
      start: { x: 10, y: 2 },
      end: { x: 10, y: 0 },
      thickness: 0.2,
    });
    expect(isExteriorDoor(building, door("north", "outer0", 3))).toBe(true);
    expect(isExteriorDoor(building, door("twig-door", "twig", 0.5))).toBe(
      false,
    );
    expect(isExteriorDoor(building, door("mixed", "outer0", 1.5))).toBe(false);
  });

  it("reclassifies after wall edits and preserves blocked state, events, IDs and names", () => {
    const building = room();
    building.exits = [door("formerly-outside", "outer0")];
    building.blocked_exit_ids = ["formerly-outside"];
    building.opening_events = [
      { step: 20, opening_id: "formerly-outside", blocked: false },
    ];
    const next = reclassifyDoors({
      ...building,
      walls: building.walls.slice(0, 3),
    });
    expect(next.doors).toEqual(building.exits);
    expect(next.exits).toEqual([]);
    expect(next.blocked_exit_ids).toEqual([]);
    expect(next.opening_events).toEqual([
      { step: 0, opening_id: "formerly-outside", blocked: true },
      ...building.opening_events,
    ]);
    expect(openingStartsBlocked(next, "formerly-outside")).toBe(true);
    expect(buildingError(next, false)).toBeNull();
    const restored = reclassifyDoors({ ...next, walls: building.walls });
    expect(restored.exits).toEqual(building.exits);
    expect(openingStartsBlocked(restored, "formerly-outside")).toBe(true);
    expect(restored.opening_events).toEqual(next.opening_events);
  });

  it("preserves a step-zero override while demoting an exit", () => {
    const building = room();
    building.exits = [door("opening", "outer0")];
    building.blocked_exit_ids = ["opening"];
    building.opening_events = [
      { step: 0, opening_id: "opening", blocked: false },
    ];
    const next = reclassifyDoors({
      ...building,
      walls: building.walls.slice(0, 3),
    });
    expect(openingStartsBlocked(next, "opening")).toBe(false);
    expect(next.opening_events).toEqual(building.opening_events);
  });
});
