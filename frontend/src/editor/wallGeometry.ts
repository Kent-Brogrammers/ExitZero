import type { BuildingScenario, Point, Wall } from "../types/simulation";

/** Same flat-ended solid intervals used by the Rust collision geometry. */
export function solidWallSegments(
  building: BuildingScenario,
  wall: Wall,
): [Point, Point][] {
  const length = Math.hypot(
    wall.end.x - wall.start.x,
    wall.end.y - wall.start.y,
  );
  if (!length) return [];
  const at = (offset: number) => ({
    x: wall.start.x + ((wall.end.x - wall.start.x) * offset) / length,
    y: wall.start.y + ((wall.end.y - wall.start.y) * offset) / length,
  });
  const openings = [
    ...building.doors,
    ...building.exits.filter(
      (exit) => !building.blocked_exit_ids.includes(exit.id),
    ),
  ]
    .filter((opening) => opening.wall_id === wall.id)
    .sort((a, b) => a.offset - b.offset);
  const segments: [Point, Point][] = [];
  let cursor = 0;
  for (const opening of openings) {
    const start = Math.max(0, Math.min(length, opening.offset));
    if (start > cursor) segments.push([at(cursor), at(start)]);
    cursor = Math.max(cursor, Math.min(length, opening.offset + opening.width));
  }
  if (cursor < length) segments.push([at(cursor), wall.end]);
  return segments;
}

export function wallPolygon(
  start: Point,
  end: Point,
  thickness: number,
): Point[] {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const nx = ((-(end.y - start.y) / length) * thickness) / 2,
    ny = (((end.x - start.x) / length) * thickness) / 2;
  return [
    { x: start.x + nx, y: start.y + ny },
    { x: end.x + nx, y: end.y + ny },
    { x: end.x - nx, y: end.y - ny },
    { x: start.x - nx, y: start.y - ny },
  ];
}
