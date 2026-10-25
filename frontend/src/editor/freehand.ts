import type { BuildingScenario, Point, Wall } from "../types/simulation";
import { distance, project } from "./geometry";
import { nextObjectName } from "./names";

export const CURVE_SAMPLE_METRES = 0.025;
export const CURVE_ERROR_METRES = 0.04;
export const MAX_CURVE_SAMPLES = 2048;
export const MAX_CURVE_SEGMENTS = 96;

/** Bounded metre-based samples, independent of zoom, CSS pixels or display density. */
export function sampleCurve(points: readonly Point[], point: Point): Point[] {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    (points.length && distance(points.at(-1)!, point) < CURVE_SAMPLE_METRES)
  )
    return [...points];
  return points.length >= MAX_CURVE_SAMPLES
    ? [...points]
    : [...points, { ...point }];
}

function simplify(points: readonly Point[]): Point[] {
  if (points.length < 3) return [...points];
  const keep = new Set([0, points.length - 1]);
  const pending = [[0, points.length - 1]];
  while (pending.length) {
    const [first, last] = pending.pop()!;
    let furthest = -1,
      error = CURVE_ERROR_METRES;
    for (let i = first! + 1; i < last!; i++) {
      const d = project(points[i]!, {
        start: points[first!]!,
        end: points[last!]!,
      }).distance;
      if (d > error) {
        error = d;
        furthest = i;
      }
    }
    if (furthest >= 0) {
      keep.add(furthest);
      pending.push([first!, furthest], [furthest, last!]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => ({ ...points[i]! }));
}

/** Preview and save use exactly this polyline; no decorative spline or hidden curve fields. */
export function curvePolyline(
  raw: readonly Point[],
  available = MAX_CURVE_SEGMENTS,
) {
  if (
    raw.length > MAX_CURVE_SAMPLES ||
    raw.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
  )
    return {
      points: [] as Point[],
      error:
        "Curve contains invalid or excessive samples; draw shorter sections.",
    };
  const finite = raw;
  const unique = finite.filter(
    (p, i) => i === 0 || distance(p, finite[i - 1]!) > 1e-8,
  );
  if (unique.length < 2)
    return { points: unique, error: "Trace a curve at least 0.1 m long." };
  // Mild low-pass smoothing on shallow bends only; intentional corners retain their exact vertex.
  const smoothed = unique.map((p, i) => {
    if (!i || i === unique.length - 1) return p;
    const a = unique[i - 1]!,
      b = unique[i + 1]!;
    const u = { x: p.x - a.x, y: p.y - a.y },
      v = { x: b.x - p.x, y: b.y - p.y };
    const cosine = (u.x * v.x + u.y * v.y) / (distance(a, p) * distance(p, b));
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return cosine > Math.cos(Math.PI / 4) &&
      distance(p, midpoint) < CURVE_ERROR_METRES
      ? { x: (a.x + 2 * p.x + b.x) / 4, y: (a.y + 2 * p.y + b.y) / 4 }
      : p;
  });
  const points = simplify(smoothed);
  // Drop a short edge only when doing so stays within the approximation tolerance.
  for (let i = 1; i < points.length;) {
    if (distance(points[i - 1]!, points[i]!) >= 0.1) {
      i++;
      continue;
    }
    let removed = false;
    for (const index of [i, i - 1]) {
      if (index <= 0 || index >= points.length - 1) continue;
      if (
        project(points[index]!, {
          start: points[index - 1]!,
          end: points[index + 1]!,
        }).distance <= CURVE_ERROR_METRES
      ) {
        points.splice(index, 1);
        i = Math.max(1, index);
        removed = true;
        break;
      }
    }
    if (!removed)
      return {
        points,
        error: "Curve bends must allow wall segments at least 0.1 m long.",
      };
  }
  if (points.length - 1 > Math.min(MAX_CURVE_SEGMENTS, available))
    return {
      points,
      error: `Curve needs ${points.length - 1} segments; limit ${Math.min(MAX_CURVE_SEGMENTS, available)}. Draw shorter sections.`,
    };
  return { points, error: null };
}

export function addFreehandWalls(
  building: BuildingScenario,
  points: readonly Point[],
  makeId = () => `wall_${crypto.randomUUID()}`,
  thickness = 0.2,
): BuildingScenario {
  const walls: Wall[] = [...building.walls];
  for (let i = 1; i < points.length; i++)
    walls.push({
      id: makeId(),
      name: nextObjectName({ ...building, walls }, "walls"),
      start: { ...points[i - 1]! },
      end: { ...points[i]! },
      thickness,
    });
  return { ...building, walls };
}
