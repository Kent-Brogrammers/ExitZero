import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario, Point, Wall } from "../types/simulation";
import { classifyDoors } from "./exteriorDoors";
import { buildingFaces } from "./topology";
import { inRing } from "./spawnGeometry";

function rooms(gap: number, angle = 0, reverse = false): BuildingScenario {
  const transform = (x: number, y: number): Point => ({
    x: 15 + x * Math.cos(angle) - y * Math.sin(angle),
    y: 12 + x * Math.sin(angle) + y * Math.cos(angle),
  });
  const segment = (
    id: string,
    x: number,
    y: number,
    xx: number,
    yy: number,
  ): Wall => ({
    id,
    start: transform(reverse ? xx : x, reverse ? yy : y),
    end: transform(reverse ? x : xx, reverse ? y : yy),
    thickness: 0.2,
  });
  return {
    ...structuredClone(example),
    width: 30,
    height: 25,
    walls: [
      segment("north", -6, -5, 6, -5),
      segment("east", 6, -5, 6, 5),
      segment("south", 6, 5, -6, 5),
      segment("west", -6, 5, -6, -5),
      segment("divider", 0, -5 + gap, 0, 5),
    ],
    doors: [],
    exits: [],
    windows: [],
    spawn_zones: [],
    obstructions: [],
    blocked_exit_ids: [],
  };
}

describe("architectural wall contact topology", () => {
  it.each([
    { angle: 0, reverse: false },
    { angle: 0.37, reverse: false },
    { angle: 0.37, reverse: true },
    { angle: 1.2, reverse: false },
  ])(
    "keeps hand-drawn room contacts closed before and after placing a door ($angle, reverse=$reverse)",
    ({ angle, reverse }) => {
      const building = rooms(0.03, angle, reverse),
        original = structuredClone(building),
        before = buildingFaces(building);
      expect(before).toHaveLength(2);
      expect(before.map((face) => face.area)).toEqual([
        expect.closeTo(60, 5),
        expect.closeTo(60, 5),
      ]);
      const edited = classifyDoors({
        ...building,
        doors: [{ id: "new-door", wall_id: "divider", offset: 3, width: 1.2 }],
      });
      expect(edited.doors).toHaveLength(1);
      expect(edited.exits).toEqual([]);
      expect(buildingFaces(edited)).toEqual(before);
      expect(building).toEqual(original);
    },
  );

  it.each([0, -0.03, 0.2])(
    "handles exact, overshooting and touching contacts at %s metres",
    (gap) => {
      const faces = buildingFaces(rooms(gap));
      expect(faces).toHaveLength(2);
      expect(faces.reduce((sum, face) => sum + face.area, 0)).toBeCloseTo(120);
    },
  );

  it.each([0.20001, 0.25, 0.5])(
    "leaves a real material gap of %s metres open",
    (gap) => {
      const faces = buildingFaces(rooms(gap));
      expect(faces).toHaveLength(1);
      expect(faces[0]!.area).toBeCloseTo(120);
      expect(inRing(faces[0]!.points, { x: 12, y: 12 })).toBe(true);
      expect(inRing(faces[0]!.points, { x: 18, y: 12 })).toBe(true);
    },
  );

  it("joins collinear and slightly staggered divider pieces without tiny extra rooms", () => {
    const building = rooms(0);
    building.walls = [
      ...building.walls.filter((wall) => wall.id !== "divider"),
      {
        id: "upper",
        start: { x: 15, y: 7 },
        end: { x: 15, y: 11.95 },
        thickness: 0.2,
      },
      {
        id: "lower",
        start: { x: 15.03, y: 12.05 },
        end: { x: 15, y: 17 },
        thickness: 0.2,
      },
    ];
    const faces = buildingFaces(building);
    expect(faces).toHaveLength(2);
    expect(faces.reduce((sum, face) => sum + face.area, 0)).toBeCloseTo(120);
    const outlines = (values: typeof faces) =>
      values
        .map((face) =>
          face.points
            .map((point) => `${point.x},${point.y}`)
            .sort()
            .join(";"),
        )
        .sort();
    expect(
      outlines(
        buildingFaces({ ...building, walls: [...building.walls].reverse() }),
      ),
    ).toEqual(outlines(faces));
  });

  it("keeps decimal angled intersections joined across floating-point hash-bin edges", () => {
    for (let i = 0; i < 40; i++) {
      const building = rooms(0.03, i * 0.137 + 0.019, i % 2 === 0);
      const shift = (i + 0.5) * 1e-6;
      building.walls = building.walls.map((wall) => ({
        ...wall,
        start: { x: wall.start.x + shift, y: wall.start.y - shift },
        end: { x: wall.end.x + shift, y: wall.end.y - shift },
      }));
      for (const walls of [building.walls, [...building.walls].reverse()]) {
        const faces = buildingFaces({ ...building, walls });
        expect(faces, `angle sample ${i}`).toHaveLength(2);
        expect(faces.reduce((sum, face) => sum + face.area, 0)).toBeCloseTo(
          120,
          5,
        );
      }
    }
  });
});
