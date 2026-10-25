import type { BuildingScenario, Point, Wall } from "../types/simulation";
import { openingSegment, wallLength, project, distance } from "./geometry";

// Match Rust and the shared opening bounds/overlap tolerance, in metres.
const OPENING_EPSILON = 1e-8;

/** Same interval sweep as Rust: touching gaps are continuous; blocked exits stay solid. */
export function solidWallSegments(
  building: BuildingScenario,
  wall: Wall,
): [Point, Point][] {
  const openings = [
    ...building.doors,
    ...building.exits.filter((o) => !building.blocked_exit_ids.includes(o.id)),
  ]
    .filter((o) => o.wall_id === wall.id)
    .sort((a, b) => a.offset - b.offset);
  const length = wallLength(wall),
    at = (offset: number) => ({
      x: wall.start.x + ((wall.end.x - wall.start.x) * offset) / length,
      y: wall.start.y + ((wall.end.y - wall.start.y) * offset) / length,
    });
  let cursor = 0;
  const segments: [Point, Point][] = [];
  for (const o of openings) {
    const start = Math.max(0, Math.min(length, o.offset)),
      end = Math.max(0, Math.min(length, o.offset + o.width));
    if (start - cursor > OPENING_EPSILON)
      segments.push([at(cursor), at(start)]);
    cursor = Math.max(cursor, end);
  }
  if (length - cursor > OPENING_EPSILON)
    segments.push([at(cursor), at(length)]);
  return segments;
}
export interface OpeningLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  anchor: Point;
}
/** Place horizontal labels in nonoverlapping rows near their real opening, in world units. */
export function openingLabels(
  building: BuildingScenario,
  px: number,
  measure: (text: string) => number,
): OpeningLabel[] {
  const placed: OpeningLabel[] = [];
  for (const [kind, items] of [
    ["Door", building.doors],
    ["Exit", building.exits],
  ] as const)
    for (const o of items) {
      const wall = building.walls.find((w) => w.id === o.wall_id);
      if (!wall) continue;
      const [a, b] = openingSegment(o, wall),
        anchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const text = `${building.blocked_exit_ids.includes(o.id) ? "Blocked exit" : kind} · ${o.width.toFixed(1)} m`;
      const width = Math.min(measure(text), building.width),
        height = 13 * px;
      const x = Math.max(
        0,
        Math.min(building.width - width, anchor.x + 7 * px),
      );
      let candidate: OpeningLabel | undefined;
      for (let row = 0; row < 40; row++) {
        const dy = (Math.floor(row / 2) + 1) * 17 * px * (row % 2 ? 1 : -1);
        const y = Math.max(height, Math.min(building.height, anchor.y + dy));
        const next = { id: o.id, text, x, y, width, height, anchor };
        candidate = next;
        if (
          !placed.some(
            (p) =>
              x < p.x + p.width + 3 * px &&
              p.x < x + width + 3 * px &&
              y - height < p.y + 3 * px &&
              p.y - p.height < y + 3 * px,
          )
        )
          break;
      }
      placed.push(candidate!);
    }
  return placed;
}

/** Pick the closest actual interval, so nearby/touching records remain individually selectable. */
export function hitOpening(
  building: BuildingScenario,
  point: Point,
  tolerance: number,
): { kind: "doors" | "exits"; id: string } | null {
  const candidates = [];
  for (const kind of ["doors", "exits"] as const)
    for (const opening of building[kind]) {
      const wall = building.walls.find((w) => w.id === opening.wall_id);
      if (!wall) continue;
      const [start, end] = openingSegment(opening, wall),
        projected = project(point, { ...wall, start, end });
      if (projected.distance < tolerance)
        candidates.push({
          kind,
          id: opening.id,
          distance: projected.distance,
          center: distance(point, {
            x: (start.x + end.x) / 2,
            y: (start.y + end.y) / 2,
          }),
        });
    }
  candidates.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.center - b.center ||
      a.id.localeCompare(b.id),
  );
  const first = candidates[0];
  return first ? { kind: first.kind, id: first.id } : null;
}
