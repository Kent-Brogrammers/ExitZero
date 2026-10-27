import { expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario, Wall } from "../types/simulation";
import { buildingError } from "./geometry";
import { addWallShape } from "./shapes";
import { nearestWallSnap, wallSnapTargets } from "./snapping";

const wall = (
  id: string,
  x: number,
  y: number,
  xx: number,
  yy: number,
): Wall => ({
  id,
  start: { x, y },
  end: { x: xx, y: yy },
  thickness: 0.2,
});

it("chooses the nearest endpoint and retains exact coordinates", () => {
  const walls = [
    wall("farther", 3, 3, 3, 8),
    wall("closer", 3.137, 3.219, 6, 8),
  ];
  const before = structuredClone(walls);
  for (const ordered of [walls, [...walls].reverse()]) {
    const match = nearestWallSnap(
      { x: 3.15, y: 3.23 },
      wallSnapTargets(ordered),
      0.5,
    );
    expect(match?.point).toEqual(walls[1]!.start);
    expect(match?.wallIds).toEqual(["closer"]);
  }
  expect(walls).toEqual(before);
});

it("finds joined corners, T junctions and actual angled intersections", () => {
  const walls = [
    wall("diagonal", 1, 1, 9, 9),
    wall("across", 1, 9, 9, 1),
    wall("branch", 5, 5, 5, 9),
  ];
  const target = nearestWallSnap(
    { x: 5.1, y: 5.05 },
    wallSnapTargets(walls),
    0.3,
  );
  expect(target?.kind).toBe("corner");
  expect(target?.point).toEqual({ x: 5, y: 5 });
  const joined = wallSnapTargets([
    wall("horizontal", 1, 1, 7, 1),
    wall("vertical", 7, 1, 7, 8),
  ]);
  expect(nearestWallSnap({ x: 7, y: 1.1 }, joined, 0.3)?.kind).toBe("corner");
});

it("does not invent corners outside segments or on parallel walls", () => {
  const targets = wallSnapTargets([
    wall("a", 1, 1, 3, 3),
    wall("parallel", 1, 2, 3, 4),
    wall("short", 5, 0, 5, 2),
  ]);
  expect(targets.every((target) => target.kind === "endpoint")).toBe(true);
  expect(nearestWallSnap({ x: 5, y: 5 }, targets, 0.5)).toBeNull();
  expect(nearestWallSnap({ x: 1, y: 1 }, targets, Infinity)).toBeNull();
});

it.each([8, 20, 100])(
  "uses a 12 CSS-pixel acquisition radius at %s pixels per metre",
  (scale) => {
    const targets = wallSnapTargets([wall("target", 5, 5, 8, 5)]);
    expect(
      nearestWallSnap({ x: 5, y: 5 + 10 / scale }, targets, 12 / scale)?.point,
    ).toEqual({ x: 5, y: 5 });
    expect(
      nearestWallSnap({ x: 5, y: 5 + 13 / scale }, targets, 12 / scale),
    ).toBeNull();
  },
);

it("excludes a moved wall's old guides without losing another wall's shared endpoint", () => {
  const targets = wallSnapTargets([
    wall("moving", 1, 1, 7, 1),
    wall("fixed", 7, 1, 7, 7),
  ]);
  expect(nearestWallSnap({ x: 1.05, y: 1 }, targets, 0.3, "moving")).toBeNull();
  expect(
    nearestWallSnap({ x: 7.05, y: 1 }, targets, 0.3, "moving")?.wallIds,
  ).toEqual(["fixed"]);
  expect(
    nearestWallSnap({ x: 7.05, y: 7 }, targets, 0.3, "moving")?.point,
  ).toEqual({ x: 7, y: 7 });
});

it("round-trips snapped geometry and preserves existing opening IDs", () => {
  const building: BuildingScenario = {
    ...structuredClone(example),
    walls: [
      wall("north", 2.13, 2.17, 10.13, 2.17),
      wall("east", 10.13, 2.17, 10.13, 8.17),
    ],
    doors: [{ id: "entrance", wall_id: "north", offset: 2, width: 1 }],
    exits: [],
    spawn_zones: [],
    obstructions: [],
    blocked_exit_ids: [],
  };
  const before = structuredClone(building);
  const targets = wallSnapTargets(building.walls);
  const start = nearestWallSnap({ x: 10.2, y: 8.2 }, targets, 0.3)!.point;
  const end = nearestWallSnap({ x: 2.2, y: 2.2 }, targets, 0.3)!.point;
  const edited = addWallShape(building, "wall", start, end, () => "new-wall");
  const restored: BuildingScenario = JSON.parse(JSON.stringify(edited));
  expect(buildingError(restored, false)).toBeNull();
  expect(restored.walls.at(-1)).toMatchObject({
    id: "new-wall",
    start: { x: 10.13, y: 8.17 },
    end: { x: 2.13, y: 2.17 },
  });
  expect(restored.doors).toEqual(before.doors);
  expect(building).toEqual(before);
  expect(restored).not.toHaveProperty("snapTargets");
});
