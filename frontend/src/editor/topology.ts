import type { BuildingScenario, Point } from "../types/simulation";
import { distance, project } from "./geometry";
const EPSILON = 1e-6,
  GAP = 0.0001;
export interface Face {
  points: Point[];
  area: number;
  inset: number;
}
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const subtract = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });

/** A dangling interior wall is a physical obstacle, not a doubled polygon edge. */
function cleanFace(walk: Point[]) {
  const points: Point[] = [];
  for (const p of walk) {
    const seen = points.findIndex(
      (q) => Math.hypot(p.x - q.x, p.y - q.y) < EPSILON,
    );
    if (seen >= 0) points.splice(seen + 1);
    else points.push(p);
  }
  return points;
}
export function buildingFaces(building: BuildingScenario): Face[] {
  const walls = building.walls;
  const cuts = walls.map(() => [0, 1]);
  const add = (i: number, t: number) => {
    if (t >= -EPSILON && t <= 1 + EPSILON)
      cuts[i]!.push(Math.max(0, Math.min(1, t)));
  };
  for (let i = 0; i < walls.length; i++)
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i]!,
        b = walls[j]!;
      const u = subtract(a.end, a.start),
        v = subtract(b.end, b.start),
        delta = subtract(b.start, a.start);
      const determinant = cross(u, v);
      if (Math.abs(determinant) > 1e-10) {
        const t = cross(delta, v) / determinant,
          s = cross(delta, u) / determinant;
        if (
          t >= -EPSILON &&
          t <= 1 + EPSILON &&
          s >= -EPSILON &&
          s <= 1 + EPSILON
        ) {
          add(i, t);
          add(j, s);
        }
      } else {
        for (const p of [a.start, a.end]) {
          const hit = project(p, b);
          if (hit.distance <= EPSILON)
            add(j, hit.offset / distance(b.start, b.end));
        }
        for (const p of [b.start, b.end]) {
          const hit = project(p, a);
          if (hit.distance <= EPSILON)
            add(i, hit.offset / distance(a.start, a.end));
        }
      }
    }
  const points: Point[] = [],
    indices = new Map<string, number>();
  const neighbors: Map<number, number>[] = [];
  function vertex(p: Point) {
    const key = `${Math.round(p.x / EPSILON)},${Math.round(p.y / EPSILON)}`;
    let id = indices.get(key);
    if (id === undefined) {
      id = points.length;
      indices.set(key, id);
      points.push(p);
      neighbors.push(new Map());
    }
    return id;
  }
  walls.forEach((wall, i) => {
    const ts = [...new Set(cuts[i]!)].sort((a, b) => a - b);
    for (let k = 1; k < ts.length; k++) {
      const at = (t: number) => ({
        x: wall.start.x + (wall.end.x - wall.start.x) * t,
        y: wall.start.y + (wall.end.y - wall.start.y) * t,
      });
      const a = vertex(at(ts[k - 1]!)),
        b = vertex(at(ts[k]!));
      if (a === b) continue;
      const thickness = Math.max(neighbors[a]!.get(b) ?? 0, wall.thickness);
      neighbors[a]!.set(b, thickness);
      neighbors[b]!.set(a, thickness);
    }
  });
  const ordered = neighbors.map((adjacent, i) =>
    [...adjacent.keys()].sort(
      (a, b) =>
        Math.atan2(points[a]!.y - points[i]!.y, points[a]!.x - points[i]!.x) -
        Math.atan2(points[b]!.y - points[i]!.y, points[b]!.x - points[i]!.x),
    ),
  );
  const visited = new Set<string>(),
    result: Face[] = [];
  for (let from = 0; from < points.length; from++)
    for (const to of ordered[from]!) {
      if (visited.has(`${from}:${to}`)) continue;
      const polygon: Point[] = [];
      let a = from,
        b = to,
        inset = GAP;
      do {
        const key = `${a}:${b}`;
        if (visited.has(key)) break;
        visited.add(key);
        polygon.push(points[a]!);
        inset = Math.max(inset, neighbors[a]!.get(b)! / 2 + GAP);
        const around = ordered[b]!,
          back = around.indexOf(a);
        const next = around[(back + around.length - 1) % around.length]!;
        a = b;
        b = next;
      } while (a !== from || b !== to);
      const boundary = cleanFace(polygon);
      const area =
        boundary.reduce(
          (sum, p, i) => sum + cross(p, boundary[(i + 1) % boundary.length]!),
          0,
        ) / 2;
      if (a === from && b === to && area > EPSILON)
        result.push({ points: boundary, area, inset });
    }
  return result.sort((a, b) => a.area - b.area);
}
