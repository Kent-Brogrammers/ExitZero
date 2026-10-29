import type { BuildingScenario, Opening } from "../types/simulation";
import { buildingFaces } from "./topology";
import { inRing } from "./spawnGeometry";
import { openingStartsBlocked } from "./openingState";

/** Exterior means one side belongs to an enclosed architectural face and the other to unbounded space. */
export function classifyDoors(building: BuildingScenario): BuildingScenario {
  const faces = buildingFaces(building);
  const indoors = (x: number, y: number) =>
    faces.some((f) => inRing(f.points, { x, y }, false));
  const exterior = (opening: Opening) => {
    const wall = building.walls.find((w) => w.id === opening.wall_id);
    if (!wall) return false;
    const dx = wall.end.x - wall.start.x,
      dy = wall.end.y - wall.start.y,
      length = Math.hypot(dx, dy);
    if (length <= 0) return false;
    const normal = { x: -dy / length, y: dx / length },
      clearance = wall.thickness / 2 + 0.001;
    const sides = [0.25, 0.5, 0.75].map((t) => {
      const offset = opening.offset + opening.width * t;
      const x = wall.start.x + (dx * offset) / length,
        y = wall.start.y + (dy * offset) / length;
      const a = indoors(x + normal.x * clearance, y + normal.y * clearance),
        b = indoors(x - normal.x * clearance, y - normal.y * clearance);
      return a !== b ? (a ? 1 : -1) : 0;
    });
    return sides[0] !== 0 && sides.every((s) => s === sides[0]);
  };
  const doors: Opening[] = [],
    exits: Opening[] = [];
  const events = [...(building.opening_events ?? [])];
  const blocked: string[] = [];
  for (const opening of [...building.doors, ...building.exits]) {
    const isExit = exterior(opening),
      wasBlocked = openingStartsBlocked(building, opening.id);
    (isExit ? exits : doors).push(opening);
    if (isExit && wasBlocked) blocked.push(opening.id);
    if (
      !isExit &&
      wasBlocked &&
      !events.some((e) => e.opening_id === opening.id && e.step === 0)
    )
      events.push({ step: 0, opening_id: opening.id, blocked: true });
  }
  events.sort((a, b) => a.step - b.step);
  return {
    ...building,
    doors,
    exits,
    blocked_exit_ids: blocked,
    ...(events.length ? { opening_events: events } : {}),
  };
}
export function openingGeometryChanged(
  a: BuildingScenario,
  b: BuildingScenario,
) {
  const key = (s: BuildingScenario) =>
    JSON.stringify([
      s.walls.map((w) => [w.id, w.start, w.end, w.thickness]),
      [...s.doors, ...s.exits]
        .sort((x, y) => x.id.localeCompare(y.id))
        .map((o) => [o.id, o.wall_id, o.offset, o.width]),
    ]);
  return key(a) !== key(b);
}
