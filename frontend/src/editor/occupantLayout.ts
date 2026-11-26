import type { BuildingScenario, Point } from "../types/simulation";
import { totalPopulation } from "../utils/population";
import { formatLength } from "../utils/units";
import {
  buildingError,
  distance,
  occupantGeometryError,
  occupantWallSegments,
  wallIntersectsRectangle,
  type Selection,
} from "./geometry";
import { segmentDistance, segmentsCross } from "./spawnGeometry";
import { elementKinds } from "./selection";
import { nextObjectName, objectName } from "./names";

export type OccupantLayoutSides = "all" | "horizontal" | "vertical";
export interface OccupantLayoutOptions {
  count: number;
  sides: OccupantLayoutSides;
  /** Clear space from the object's footprint to each person's body, in metres. */
  clearance: number;
}
export interface OccupantLayoutResult {
  building: BuildingScenario;
  selections: Selection[];
  available: number;
  error: string | null;
}

/** Deterministic drafting positions. No seated state, routing or simulation timing is added. */
export function occupantsAroundObject(
  building: BuildingScenario,
  objectId: string,
  options: OccupantLayoutOptions,
  makeId = () => `occupant_${crypto.randomUUID()}`,
): OccupantLayoutResult {
  const failure = (error: string): OccupantLayoutResult => ({
    building,
    selections: [],
    available: 0,
    error,
  });
  const object = building.obstructions.find((item) => item.id === objectId);
  if (!object) return failure("Select one rectangular object or table first.");
  if (
    !Number.isInteger(options.count) ||
    options.count < 1 ||
    options.count > 100
  )
    return failure("Choose a whole number from 1 to 100 people.");
  if (
    !["all", "horizontal", "vertical"].includes(options.sides) ||
    !Number.isFinite(options.clearance) ||
    options.clearance < 0 ||
    options.clearance > 2
  )
    return failure(
      `Choose the sides and a clearance between 0 and ${formatLength(2)}.`,
    );
  const sourceProblem = buildingError(building, false);
  if (sourceProblem) return failure(sourceProblem);
  const population = totalPopulation(building),
    limit = building.pursuit ? 64 : 10000;
  if (population + options.count > limit)
    return failure(
      `This layout has ${population} occupants. Adding ${options.count} would exceed its ${limit}-person limit.`,
    );
  const radius = building.agent_radius,
    diameter = radius * 2;
  // A small drafting margin keeps all generated bodies away from exact collision tangencies.
  const offset = radius + options.clearance + 1e-5,
    pitch = diameter + 0.1;
  const candidates: { point: Point; anchor: Point }[] = [];
  const side = (horizontal: boolean, far: boolean, reverse: boolean) => {
    const length = horizontal ? object.width : object.height;
    const slots = Math.min(128, Math.max(1, Math.floor(length / pitch)));
    for (let i = 0; i < slots; i++) {
      const fraction = ((reverse ? slots - 1 - i : i) + 0.5) / slots;
      const anchor = horizontal
        ? {
            x: object.x + object.width * fraction,
            y: object.y + (far ? object.height : 0),
          }
        : {
            x: object.x + (far ? object.width : 0),
            y: object.y + object.height * fraction,
          };
      candidates.push({
        anchor,
        point: {
          x: anchor.x + (horizontal ? 0 : far ? offset : -offset),
          y: anchor.y + (horizontal ? (far ? offset : -offset) : 0),
        },
      });
    }
  };
  if (options.sides !== "vertical") side(true, false, false);
  if (options.sides !== "horizontal") side(false, true, false);
  if (options.sides !== "vertical") side(true, true, true);
  if (options.sides !== "horizontal") side(false, false, true);

  const walls = occupantWallSegments(building),
    available: Point[] = [];
  for (const { point, anchor } of candidates) {
    if (occupantGeometryError(building, point, walls)) continue;
    if (
      [...(building.placed_occupants ?? []), ...available].some(
        (other) => distance(point, other) < diameter + 1e-6,
      )
    )
      continue;
    // Keep proposals on the object's side of intervening walls and objects. This is a local
    // placement check, not an inferred escape route or a replacement for navigation.
    if (
      walls.some(
        (wall) =>
          segmentsCross(anchor, point, wall.start, wall.end) ||
          Math.min(
            segmentDistance(anchor, wall.start, wall.end),
            segmentDistance(point, wall.start, wall.end),
            segmentDistance(wall.start, anchor, point),
            segmentDistance(wall.end, anchor, point),
          ) <=
            wall.thickness / 2 + 1e-6,
      )
    )
      continue;
    if (
      building.obstructions.some(
        (other) =>
          other.id !== object.id &&
          wallIntersectsRectangle(
            { id: "placement", start: anchor, end: point, thickness: 0 },
            other,
          ),
      )
    )
      continue;
    available.push(point);
  }
  const count = Math.min(options.count, available.length);
  const positions = Array.from(
    { length: count },
    (_, i) => available[Math.floor(((i + 0.5) * available.length) / count)]!,
  );
  const next = {
    ...building,
    placed_occupants: [...(building.placed_occupants ?? [])],
  };
  const used = new Set(
    elementKinds.flatMap((kind) =>
      (building[kind] ?? []).map((item) => item.id),
    ),
  );
  const selections: Selection[] = [];
  const prefix =
    [...objectName(building, { kind: "obstructions", id: objectId })]
      .slice(0, 56)
      .join("") + " person";
  for (const position of positions) {
    const id = makeId();
    if (used.has(id))
      return failure(
        "Could not create unique occupant IDs. Close and try again.",
      );
    used.add(id);
    next.placed_occupants.push({
      id,
      name: nextObjectName(next, "placed_occupants", prefix),
      ...position,
    });
    selections.push({ kind: "placed_occupants", id });
  }
  return {
    building: next,
    selections,
    available: available.length,
    error:
      buildingError(next, false) ??
      (count < options.count
        ? `Found ${count} clear positions for ${options.count} people. Reduce the count, change sides or clearance, or make more room.`
        : null),
  };
}
