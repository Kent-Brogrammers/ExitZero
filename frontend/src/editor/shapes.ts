import type { BuildingScenario, Point, Wall } from "../types/simulation";
import { nextObjectName } from "./names";

export const CIRCLE_WALL_SEGMENTS = 32;
export type WallShape = "wall" | "wall-rectangle" | "wall-circle";
type Bounds = Pick<BuildingScenario, "width" | "height">;

/** Square is a drawing constraint; persisted objects remain ordinary rectangles. */
export function dragRectangle(
  start: Point,
  end: Point,
  bounds: Bounds,
  square = false,
) {
  let dx = end.x - start.x,
    dy = end.y - start.y;
  if (square) {
    const side = Math.min(
      Math.max(Math.abs(dx), Math.abs(dy)),
      dx < 0 ? start.x : bounds.width - start.x,
      dy < 0 ? start.y : bounds.height - start.y,
    );
    dx = side * (dx < 0 ? -1 : 1);
    dy = side * (dy < 0 ? -1 : 1);
  }
  return {
    x: Math.min(start.x, start.x + dx),
    y: Math.min(start.y, start.y + dy),
    width: Math.abs(dx),
    height: Math.abs(dy),
  };
}

/** Return the actual centreline vertices, including an exactly closed last point. */
export function wallShapePoints(
  shape: WallShape,
  start: Point,
  end: Point,
  bounds: Bounds,
  constrain = false,
): Point[] {
  if (shape === "wall") return [start, end];
  if (shape === "wall-rectangle") {
    const r = dragRectangle(start, end, bounds, constrain);
    const first = { x: r.x, y: r.y };
    return [
      first,
      { x: r.x + r.width, y: r.y },
      { x: r.x + r.width, y: r.y + r.height },
      { x: r.x, y: r.y + r.height },
      first,
    ];
  }
  const r = dragRectangle(start, end, bounds, constrain);
  const center = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  const points = Array.from({ length: CIRCLE_WALL_SEGMENTS }, (_, i) => {
    const angle = (i * Math.PI * 2) / CIRCLE_WALL_SEGMENTS;
    return {
      x: center.x + (r.width / 2) * Math.cos(angle),
      y: center.y + (r.height / 2) * Math.sin(angle),
    };
  });
  return [...points, points[0]!];
}

export function addWallShape(
  building: BuildingScenario,
  shape: WallShape,
  start: Point,
  end: Point,
  makeId = () => `wall_${crypto.randomUUID()}`,
  constrain = false,
): BuildingScenario {
  const points = wallShapePoints(shape, start, end, building, constrain);
  const walls: Wall[] = [...building.walls];
  for (let i = 1; i < points.length; i++) {
    walls.push({
      id: makeId(),
      name: nextObjectName({ ...building, walls }, "walls"),
      start: { ...points[i - 1]! },
      end: { ...points[i]! },
      thickness: 0.2,
    });
  }
  return { ...building, walls };
}

export function addObject(
  building: BuildingScenario,
  start: Point,
  end: Point,
  square: boolean,
  id = `obstruction_${crypto.randomUUID()}`,
): BuildingScenario {
  return {
    ...building,
    obstructions: [
      ...building.obstructions,
      {
        id,
        name: nextObjectName(building, "obstructions", "Object"),
        ...dragRectangle(start, end, building, square),
      },
    ],
  };
}
