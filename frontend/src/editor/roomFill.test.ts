import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario, Point, Wall } from "../types/simulation";
import { buildingError } from "./geometry";
import { spawnContains, spawnZonesOverlap } from "./spawnGeometry";
import {
  detectRoom,
  populateRoom,
  resizeRoomPopulation,
  roomContains,
  roomFillZones,
} from "./roomFill";

function perimeter(points: Point[], prefix = "wall"): Wall[] {
  return points.map((start, i) => ({
    id: `${prefix}-${i}`,
    start,
    end: points[(i + 1) % points.length]!,
    thickness: 0.2,
  }));
}
function fixture(): BuildingScenario {
  return {
    ...structuredClone(example),
    width: 14,
    height: 12,
    walls: [
      ...perimeter([
        { x: 1, y: 1 },
        { x: 13, y: 1 },
        { x: 13, y: 11 },
        { x: 1, y: 11 },
      ]),
      {
        id: "divider",
        start: { x: 7, y: 1 },
        end: { x: 7, y: 11 },
        thickness: 0.2,
      },
    ],
    doors: [{ id: "door", wall_id: "divider", offset: 4, width: 1.4 }],
    exits: [{ id: "exit", wall_id: "wall-1", offset: 6, width: 1.4 }],
    windows: [{ id: "window", wall_id: "wall-3", offset: 3, width: 1.2 }],
    obstructions: [{ id: "desk", x: 3, y: 3, width: 1.5, height: 1 }],
    spawn_zones: [
      { id: "left-spawn", x: 2, y: 7, width: 1.2, height: 1.2, count: 2 },
      { id: "right-spawn", x: 9, y: 3, width: 2, height: 2, count: 3 },
    ],
    blocked_exit_ids: [],
    agent_radius: 0.22,
  };
}

describe("room fill as a single spawn polygon", () => {
  it("keeps dangling interior walls out of the polygon boundary", () => {
    const b = fixture();
    b.spawn_zones = [];
    b.doors = [];
    b.walls = b.walls.filter((w) => w.id !== "divider");
    b.walls.push({
      id: "spur",
      start: { x: 7, y: 1 },
      end: { x: 7, y: 6 },
      thickness: 0.2,
    });
    const room = detectRoom(b, { x: 2, y: 2 });
    const fill = populateRoom(b, room, 10, "spur-room");
    expect(buildingError(fill.building)).toBeNull();
    expect(fill.ids).toHaveLength(1);
    expect(fill.building.spawn_zones[0]!.polygon).not.toContainEqual({
      x: 7,
      y: 6,
    });
  });
  it("finds rooms at T intersections and keeps door/window spans as room boundaries", () => {
    const b = fixture(),
      room = detectRoom(b, { x: 2, y: 2 });
    expect(room.spawnIds).toEqual(["left-spawn"]);
    expect(roomContains(room, { x: 6, y: 8 })).toBe(true);
    expect(roomContains(room, { x: 8, y: 8 })).toBe(false);
    b.walls.push({
      id: "cross",
      start: { x: 1, y: 6 },
      end: { x: 13, y: 6 },
      thickness: 0.2,
    });
    const quarter = detectRoom(b, { x: 2, y: 2 });
    expect(roomContains(quarter, { x: 2, y: 8 })).toBe(false);
    expect(roomContains(quarter, { x: 9, y: 3 })).toBe(false);
  });
  it("fills clear space around furniture, replacing only occupants inside that room, with deterministic JSON", () => {
    const b = fixture(),
      raw = JSON.stringify(b),
      room = detectRoom(b, { x: 2, y: 2 });
    const result = populateRoom(b, room, 20, "test");
    const zones = roomFillZones(result.building, result.ids[0]!);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.polygon).toEqual(room.boundary);
    expect(zones.reduce((sum, z) => sum + z.count, 0)).toBe(20);
    expect(
      result.building.spawn_zones.find((z) => z.id === "right-spawn"),
    ).toEqual(b.spawn_zones[1]);
    expect(result.building.spawn_zones.some((z) => z.id === "left-spawn")).toBe(
      false,
    );
    expect(buildingError(result.building)).toBeNull();
    for (const z of zones) {
      expect(z.width).toBeGreaterThanOrEqual(b.agent_radius * 2);
      expect(z.height).toBeGreaterThanOrEqual(b.agent_radius * 2);
      expect(spawnContains(z, { x: 2, y: 2 }, b.agent_radius)).toBe(true);
      expect(spawnZonesOverlap(z, b.spawn_zones[1]!)).toBe(false);
    }
    expect(populateRoom(b, room, 20, "test")).toEqual(result);
    expect(JSON.parse(JSON.stringify(result.building))).toEqual(
      result.building,
    );
    expect(JSON.stringify(b)).toBe(raw);
  });
  it.each([
    [
      { x: 1, y: 1 },
      { x: 11, y: 1 },
      { x: 1, y: 11 },
    ],
    [
      { x: 1, y: 1 },
      { x: 11, y: 1 },
      { x: 11, y: 5 },
      { x: 6, y: 5 },
      { x: 6, y: 11 },
      { x: 1, y: 11 },
    ],
  ])("supports angled and concave room boundaries", (...points) => {
    const b = fixture();
    b.walls = perimeter(points);
    b.doors = [];
    b.exits = [{ ...b.exits[0]!, wall_id: "wall-0", offset: 2 }];
    b.windows = [];
    b.spawn_zones = [];
    const room = detectRoom(b, { x: 2, y: 2 }),
      fill = populateRoom(b, room, 12, "angles");
    expect(buildingError(fill.building)).toBeNull();
    expect(fill.ids).toHaveLength(1);
    expect(fill.building.spawn_zones[0]!.polygon).toEqual(room.boundary);
    for (const p of room.boundary) expect(roomContains(room, p)).toBe(true);
  });
  it("excludes a nested closed room instead of filling through its perimeter", () => {
    const b = fixture();
    b.walls = [
      ...b.walls.filter((w) => w.id !== "divider"),
      ...perimeter(
        [
          { x: 5, y: 5 },
          { x: 9, y: 5 },
          { x: 9, y: 9 },
          { x: 5, y: 9 },
        ],
        "closet",
      ),
    ];
    b.doors = [];
    b.spawn_zones = [];
    const room = detectRoom(b, { x: 2, y: 2 });
    expect(roomContains(room, { x: 7, y: 7 })).toBe(false);
    const fill = populateRoom(b, room, 15, "nested");
    expect(buildingError(fill.building)).toBeNull();
    expect(fill.building.spawn_zones).toHaveLength(1);
    expect(fill.building.spawn_zones[0]!.holes).toHaveLength(1);
    expect(spawnContains(fill.building.spawn_zones[0]!, { x: 7, y: 7 })).toBe(
      false,
    );
  });
  it("keeps room-total editing available after serialization, without changing other rooms", () => {
    const b = fixture();
    const first = populateRoom(b, detectRoom(b, { x: 2, y: 2 }), 20, "saved");
    const loaded = JSON.parse(
      JSON.stringify(first.building),
    ) as BuildingScenario;
    const changed = resizeRoomPopulation(loaded, first.ids[0]!, 7);
    expect(
      roomFillZones(changed.building, changed.ids[0]!).reduce(
        (sum, z) => sum + z.count,
        0,
      ),
    ).toBe(7);
    const restored = resizeRoomPopulation(
      changed.building,
      changed.ids[0]!,
      20,
    );
    expect(restored.building).toEqual(first.building);
    expect(
      restored.building.spawn_zones.find((z) => z.id === "right-spawn"),
    ).toEqual(b.spawn_zones[1]);
  });
  it("keeps adjacent polygon room fills separate even when they share a wall", () => {
    const b = fixture();
    b.spawn_zones = [];
    const left = populateRoom(b, detectRoom(b, { x: 2, y: 2 }), 10, "left");
    const rightRoom = detectRoom(left.building, { x: 10, y: 2 });
    expect(rightRoom.spawnIds).toEqual([]);
    const right = populateRoom(left.building, rightRoom, 10, "right");
    expect(right.building.spawn_zones).toHaveLength(2);
    expect(right.building.spawn_zones[0]).toEqual(left.building.spawn_zones[0]);
    expect(buildingError(right.building)).toBeNull();
  });
  it("reports open perimeters, wall clicks and unsafe populations without mutating the building", () => {
    const b = fixture(),
      raw = JSON.stringify(b);
    expect(() => detectRoom(b, { x: 7, y: 4 })).toThrow(/away from.*walls/);
    expect(() => detectRoom(b, { x: 0, y: 0 })).toThrow(/enclosed room/);
    const open = { ...b, walls: b.walls.filter((w) => w.id !== "wall-0") };
    expect(() => detectRoom(open, { x: 2, y: 2 })).toThrow(/Connect/);
    const room = detectRoom(b, { x: 2, y: 2 });
    for (const bad of [0, 1.5, NaN])
      expect(() => populateRoom(b, room, bad)).toThrow(/whole number/);
    expect(() => populateRoom(b, room, 10000)).toThrow(/clearance/);
    expect(JSON.stringify(b)).toBe(raw);
  });
});
