import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario, Point, SpawnZone } from "../types/simulation";
import { addPolygonSpawn } from "./shapes";
import { buildingError, translateElement } from "./geometry";
import { moveSelection, resizeSelection } from "./selection";
import {
  polygonBounds,
  spawnContains,
  spawnZonesOverlap,
} from "./spawnGeometry";

const polygon: Point[] = [
  { x: 2, y: 2 },
  { x: 10, y: 2 },
  { x: 10, y: 5 },
  { x: 5, y: 5 },
  { x: 5, y: 10 },
  { x: 2, y: 10 },
];
const region = (): SpawnZone => ({
  id: "polygon",
  ...polygonBounds(polygon),
  polygon: structuredClone(polygon),
  count: 12,
});
describe("polygon spawn regions", () => {
  it("keeps concave geometry and count across serialization, dragging and scaling", () => {
    const b: BuildingScenario = {
      ...structuredClone(example),
      spawn_zones: [region()],
    };
    expect(buildingError(b)).toBeNull();
    expect(spawnContains(b.spawn_zones[0]!, { x: 8, y: 8 })).toBe(false);
    expect(spawnContains(b.spawn_zones[0]!, { x: 4.9, y: 8 }, 0.2)).toBe(false);
    const items = [{ kind: "spawn_zones" as const, id: "polygon" }];
    const moved = moveSelection(b, items, { x: 1, y: 1 });
    expect(moved.spawn_zones[0]!.polygon![0]).toEqual({ x: 3, y: 3 });
    const single = translateElement(b, items[0]!, { x: 1, y: 1 });
    expect(single).toEqual(moved);
    const scaled = resizeSelection(moved, items, 4, 4);
    expect(buildingError(scaled)).toBeNull();
    expect(scaled.spawn_zones[0]!.count).toBe(12);
    expect(scaled.spawn_zones[0]!.polygon![2]).toEqual({ x: 7, y: 4.5 });
    expect(JSON.parse(JSON.stringify(scaled))).toEqual(scaled);
  });
  it("supports holes and disjoint regions whose bounding boxes overlap", () => {
    const a: SpawnZone = {
      id: "a",
      x: 2,
      y: 2,
      width: 8,
      height: 8,
      count: 1,
      polygon: [
        { x: 2, y: 2 },
        { x: 10, y: 2 },
        { x: 2, y: 10 },
      ],
    };
    const b: SpawnZone = {
      ...a,
      id: "b",
      polygon: [
        { x: 10, y: 2 },
        { x: 10, y: 10 },
        { x: 2, y: 10 },
      ],
    };
    expect(spawnZonesOverlap(a, b)).toBe(false);
    expect(buildingError({ ...example, spawn_zones: [a, b] })).toBeNull();
    const hole = [
      { x: 3, y: 3 },
      { x: 4, y: 3 },
      { x: 4, y: 4 },
      { x: 3, y: 4 },
    ];
    const zone = { ...region(), holes: [hole] };
    expect(buildingError({ ...example, spawn_zones: [zone] })).toBeNull();
    expect(spawnContains(zone, { x: 3.5, y: 3.5 })).toBe(false);
    expect(spawnContains(zone, { x: 2.9, y: 3.5 }, 0.2)).toBe(false);
    expect(
      spawnZonesOverlap(zone, {
        id: "inside-hole",
        x: 3.1,
        y: 3.1,
        width: 0.8,
        height: 0.8,
        count: 1,
      }),
    ).toBe(false);
  });
  it("rejects self intersections, stale bounds, crossing holes and overlapping regions", () => {
    for (const zone of [
      {
        ...region(),
        polygon: [
          { x: 2, y: 2 },
          { x: 10, y: 10 },
          { x: 2, y: 10 },
          { x: 10, y: 2 },
        ],
      },
      { ...region(), x: 1 },
      {
        ...region(),
        holes: [
          [
            { x: 4, y: 4 },
            { x: 8, y: 4 },
            { x: 8, y: 8 },
          ],
        ],
      },
    ])
      expect(buildingError({ ...example, spawn_zones: [zone] })).not.toBeNull();
    expect(
      buildingError({
        ...example,
        spawn_zones: [
          region(),
          { id: "overlap", x: 3, y: 3, width: 1, height: 1, count: 1 },
        ],
      }),
    ).toContain("overlap");
  });
  it("creates a polygon without converting it to rectangles", () => {
    const b = addPolygonSpawn(
      { ...example, spawn_zones: [] },
      polygon,
      "manual",
    );
    expect(b.spawn_zones).toHaveLength(1);
    expect(b.spawn_zones[0]!.polygon).toEqual(polygon);
    expect(buildingError(b)).toBeNull();
  });
});
