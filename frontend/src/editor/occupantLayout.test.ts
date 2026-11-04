import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import { buildingError, distance } from "./geometry";
import {
  occupantsAroundObject,
  type OccupantLayoutOptions,
} from "./occupantLayout";
import { rotateObstruction } from "./selection";
import { totalPopulation } from "../utils/population";

const options: OccupantLayoutOptions = {
  count: 6,
  sides: "all",
  clearance: 0.15,
};
function fixture(): BuildingScenario {
  return {
    ...structuredClone(example),
    spawn_zones: [],
    obstructions: [
      {
        id: "table",
        name: "Conference table",
        x: 8,
        y: 7,
        width: 3.2,
        height: 1.6,
      },
    ],
  };
}
function create(b = fixture(), opts = options, makeId?: () => string) {
  let next = 0;
  return occupantsAroundObject(
    b,
    "table",
    opts,
    makeId ?? (() => `new-person-${++next}`),
  );
}

describe("people around rectangular objects", () => {
  it("creates deterministic, named exact positions with full body clearance and unchanged source geometry", () => {
    const source = fixture(),
      json = JSON.stringify(source);
    const result = create(source);
    expect(result.error).toBeNull();
    expect(result.selections).toHaveLength(6);
    expect(buildingError(result.building)).toBeNull();
    expect(result.building.walls).toEqual(source.walls);
    expect(result.building.obstructions).toEqual(source.obstructions);
    expect(JSON.stringify(source)).toBe(json);
    expect(result.building).toEqual(create(source).building);
    expect(result.building.placed_occupants![0]!.name).toBe(
      "Conference table person 1",
    );
    expect(totalPopulation(result.building)).toBe(6);
    for (const [i, person] of result.building.placed_occupants!.entries()) {
      expect(person).not.toHaveProperty("width");
      for (const other of result.building.placed_occupants!.slice(i + 1))
        expect(distance(person, other)).toBeGreaterThan(
          source.agent_radius * 2,
        );
    }
    expect(
      buildingError(JSON.parse(JSON.stringify(result.building))),
    ).toBeNull();
  });

  it.each(["horizontal", "vertical"] as const)(
    "respects %s side choice and actual rotated geometry",
    (sides) => {
      const b = rotateObstruction(fixture(), "table"),
        table = b.obstructions[0]!;
      const result = create(b, { ...options, count: 2, sides });
      expect(result.error).toBeNull();
      expect(buildingError(result.building)).toBeNull();
      for (const person of result.building.placed_occupants!) {
        if (sides === "horizontal")
          expect(person.y < table.y || person.y > table.y + table.height).toBe(
            true,
          );
        else
          expect(person.x < table.x || person.x > table.x + table.width).toBe(
            true,
          );
      }
    },
  );

  it("skips existing bodies, nearby furniture and workspace edges while retaining original IDs, names and counts", () => {
    const b = fixture();
    const first = create(b, { ...options, count: 1 }).building
      .placed_occupants![0]!;
    b.placed_occupants = [{ ...first, id: "existing", name: "Staff" }];
    b.obstructions.push({
      id: "cabinet",
      x: 11.3,
      y: 6.9,
      width: 1,
      height: 2,
    });
    b.spawn_zones = [
      { id: "area", x: 20, y: 12, width: 3, height: 3, count: 4 },
    ];
    const result = create(b, { ...options, count: 4 });
    expect(result.error).toBeNull();
    expect(result.building.placed_occupants![0]).toEqual(b.placed_occupants[0]);
    expect(result.building.spawn_zones).toEqual(b.spawn_zones);
    expect(totalPopulation(result.building)).toBe(9);
    expect(buildingError(result.building)).toBeNull();
    const edge = fixture();
    Object.assign(edge.obstructions[0]!, { x: 0, y: 0 });
    const nearEdge = create(edge, { ...options, count: 4 });
    expect(nearEdge.error).toBeNull();
    expect(buildingError(nearEdge.building)).toBeNull();
  });

  it("does not place people beyond an intervening wall even if the final point is clear", () => {
    const b = fixture();
    b.walls.push({
      id: "near-top",
      start: { x: 7, y: 6.4 },
      end: { x: 13, y: 6.4 },
      thickness: 0.2,
    });
    const result = create(b, {
      ...options,
      count: 3,
      sides: "horizontal",
      clearance: 1.5,
    });
    expect(result.error).toBeNull();
    expect(result.building.placed_occupants!.every((p) => p.y > 8.6)).toBe(
      true,
    );
    expect(buildingError(result.building)).toBeNull();
  });

  it("returns a clearly incomplete preview without silently applying fewer people", () => {
    const b = fixture();
    const result = create(b, { ...options, count: 100 });
    expect(result.error).toMatch(/Found \d+ clear positions for 100/);
    expect(result.selections.length).toBeLessThan(100);
    expect(result.selections.length).toBeGreaterThan(0);
    expect(buildingError(result.building)).toBeNull();
    expect(b.placed_occupants).toBeUndefined();
  });

  it.each([0, -1, 1.5, NaN, 101])(
    "rejects invalid count %s without modifying the building",
    (count) => {
      const b = fixture(),
        result = create(b, { ...options, count });
      expect(result.building).toBe(b);
      expect(result.error).toMatch(/whole number/);
    },
  );

  it("respects combined population limits, unique IDs and Unicode name lengths", () => {
    const b = fixture();
    b.agent_radius = 0.01;
    b.spawn_zones = [
      { id: "area", x: 20, y: 12, width: 3, height: 3, count: 10000 },
    ];
    expect(create(b, { ...options, count: 1 }).error).toMatch(
      /10000-person limit/,
    );
    const limited = fixture();
    limited.spawn_zones = [
      { id: "area", x: 20, y: 12, width: 4, height: 4, count: 64 },
    ];
    limited.pursuit = {
      stalker_start: { x: 3, y: 3 },
      stalker_speed: 1.5,
      survivor_speed: 1.4,
      capture_radius: 0.5,
      avoidance_radius: 5,
    };
    expect(create(limited, { ...options, count: 1 }).error).toMatch(
      /64-person limit/,
    );
    expect(create(fixture(), options, () => "table").error).toMatch(
      /unique occupant IDs/,
    );
    const named = fixture();
    named.obstructions[0]!.name = "🪑".repeat(80);
    const result = create(named);
    expect(result.error).toBeNull();
    expect(
      result.building.placed_occupants!.every((p) => [...p.name!].length <= 80),
    ).toBe(true);
    expect(buildingError(result.building)).toBeNull();
  });

  it("has no space when furniture is boxed in by solid walls", () => {
    const b = fixture(),
      t = b.obstructions[0]!;
    for (const [id, x1, y1, x2, y2] of [
      ["a", t.x - 0.4, t.y - 0.4, t.x + t.width + 0.4, t.y - 0.4],
      [
        "b",
        t.x + t.width + 0.4,
        t.y - 0.4,
        t.x + t.width + 0.4,
        t.y + t.height + 0.4,
      ],
      [
        "c",
        t.x + t.width + 0.4,
        t.y + t.height + 0.4,
        t.x - 0.4,
        t.y + t.height + 0.4,
      ],
      ["d", t.x - 0.4, t.y + t.height + 0.4, t.x - 0.4, t.y - 0.4],
    ] as const)
      b.walls.push({
        id,
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness: 0.2,
      });
    const result = create(b);
    expect(result.error).toMatch(/Found 0 clear/);
    expect(result.selections).toEqual([]);
  });
});
