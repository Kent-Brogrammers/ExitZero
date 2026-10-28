import type { Point, Wall } from "../types/simulation";

export interface WallSnapTarget {
  point: Point;
  kind: "endpoint" | "corner";
  wallIds: readonly string[];
}

/** Drafting guides only: intersections do not split or alter persisted walls. */
export function wallSnapTargets(walls: readonly Wall[]): WallSnapTarget[] {
  const targets: WallSnapTarget[] = walls.flatMap((wall) =>
    [wall.start, wall.end].map((point) => ({
      point: { ...point },
      kind: "endpoint" as const,
      wallIds: [wall.id],
    })),
  );
  for (let i = 0; i < walls.length; i++) {
    const a = walls[i]!;
    const rx = a.end.x - a.start.x,
      ry = a.end.y - a.start.y;
    for (let j = i + 1; j < walls.length; j++) {
      const b = walls[j]!;
      const sx = b.end.x - b.start.x,
        sy = b.end.y - b.start.y;
      const denominator = rx * sy - ry * sx;
      if (
        Math.abs(denominator) <=
        1e-10 * Math.hypot(rx, ry) * Math.hypot(sx, sy)
      )
        continue;
      const dx = b.start.x - a.start.x,
        dy = b.start.y - a.start.y;
      const t = (dx * sy - dy * sx) / denominator;
      const u = (dx * ry - dy * rx) / denominator;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const point =
        t === 0
          ? a.start
          : t === 1
            ? a.end
            : u === 0
              ? b.start
              : u === 1
                ? b.end
                : { x: a.start.x + t * rx, y: a.start.y + t * ry };
      targets.push({
        point: { ...point },
        kind: "corner",
        wallIds: [a.id, b.id],
      });
    }
  }
  return targets;
}

/** Radius is supplied in world units from the current CSS-pixel scale. */
export function nearestWallSnap(
  point: Point,
  targets: readonly WallSnapTarget[],
  radius: number,
  excludedWallId?: string,
  accepts?: (target: WallSnapTarget) => boolean,
): WallSnapTarget | null {
  if (!Number.isFinite(radius) || radius <= 0) return null;
  let best: WallSnapTarget | null = null;
  let bestDistance = radius * radius;
  for (const target of targets) {
    // An endpoint edit must not be attracted to its own previous position or
    // to an intersection that depends on that wall's old geometry.
    if (excludedWallId && target.wallIds.includes(excludedWallId)) continue;
    if (accepts && !accepts(target)) continue;
    const squared =
      (point.x - target.point.x) ** 2 + (point.y - target.point.y) ** 2;
    if (
      squared < bestDistance ||
      (squared === bestDistance &&
        target.kind === "corner" &&
        best?.kind === "endpoint")
    ) {
      best = target;
      bestDistance = squared;
    }
  }
  return best;
}
