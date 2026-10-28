import { expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import { buildingError } from "./geometry";
import { addWallShape, wallShapePoints } from "./shapes";
import { constrainWallEnd, isOnLockedWallAngle } from "./wallAngles";

const start = { x: 10, y: 10 };
const bounds = { width: 30, height: 20 };

it.each([
  [18, 11, 18, 10],
  [11, 18, 10, 18],
  [17, 15, 16, 16],
  [3, 15, 4, 16],
  [3, 5, 4, 4],
  [17, 5, 16, 4],
  [2, 9, 2, 10],
  [9, 2, 10, 2],
])("locks (%s, %s) to the nearest forward 45° ray", (x, y, xx, yy) => {
  const end = constrainWallEnd(start, { x, y }, bounds);
  expect(end).toEqual({ x: xx, y: yy });
  expect(isOnLockedWallAngle(start, { x, y }, end)).toBe(true);
});

it("shortens a diagonal at workspace edges without bending it", () => {
  const end = constrainWallEnd({ x: 0.2, y: 2 }, { x: 0, y: 2.4 }, bounds);
  expect(end.x).toBe(0);
  expect(end.y).toBeCloseTo(2.2);
  expect(constrainWallEnd(start, start, bounds)).toEqual(start);
});

it("rounds grid distance along the locked ray, including off-grid wall starts", () => {
  const anchor = { x: 2.13, y: 2.17 };
  const end = constrainWallEnd(anchor, { x: 8.2, y: 8 }, bounds, 0.3048);
  expect(end.x / 0.3048).toBeCloseTo(Math.round(end.x / 0.3048));
  expect(end.x - anchor.x).toBeCloseTo(end.y - anchor.y);
  expect(anchor).toEqual({ x: 2.13, y: 2.17 });
});

it("keeps exact compatible snap targets and rejects off-angle or opposite targets", () => {
  const anchor = { x: 2.13, y: 2.17 };
  const target = { x: 8.13, y: 8.17 };
  expect(isOnLockedWallAngle(anchor, { x: 8.2, y: 8 }, target)).toBe(true);
  expect(constrainWallEnd(anchor, target, bounds)).toEqual(target);
  expect(isOnLockedWallAngle(start, { x: 18, y: 11 }, { x: 18, y: 10.1 })).toBe(
    false,
  );
  expect(isOnLockedWallAngle(start, { x: 18, y: 11 }, { x: 2, y: 10 })).toBe(
    false,
  );
});

it("shares preview geometry with valid serialized walls and leaves existing references intact", () => {
  const building = structuredClone(example);
  const before = structuredClone(building);
  const pointer = { x: 17, y: 15 };
  const preview = wallShapePoints("wall", start, pointer, building, true);
  const edited = addWallShape(
    building,
    "wall",
    start,
    pointer,
    () => "locked-wall",
    true,
  );
  const wall = edited.walls.at(-1)!;
  expect([wall.start, wall.end]).toEqual(preview);
  expect(wall.end).toEqual({ x: 16, y: 16 });
  expect(buildingError(edited, false)).toBeNull();
  expect(JSON.parse(JSON.stringify(edited))).toEqual(edited);
  expect(edited.doors).toEqual(before.doors);
  expect(edited.exits).toEqual(before.exits);
  expect(building).toEqual(before);
  expect(wallShapePoints("wall", start, pointer, bounds)).toEqual([
    start,
    pointer,
  ]);
});
