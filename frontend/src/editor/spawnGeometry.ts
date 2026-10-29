import type { Point, SpawnZone } from "../types/simulation";

const EPS = 1e-8;
export function isSpawnZone(value: unknown): value is SpawnZone {
  return (
    !!value &&
    typeof value === "object" &&
    "count" in value &&
    typeof value.count === "number" &&
    "x" in value
  );
}
export const signedArea = (ring: readonly Point[]) =>
  ring.reduce((sum, p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    return sum + p.x * q.y - p.y * q.x;
  }, 0) / 2;
export function polygonBounds(points: readonly Point[]) {
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}
export function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
    ),
  );
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
export function segmentsCross(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
  touching = true,
) {
  if (
    cross(a, b, c) * cross(a, b, d) < -EPS * EPS &&
    cross(c, d, a) * cross(c, d, b) < -EPS * EPS
  )
    return true;
  return (
    touching &&
    (segmentDistance(a, c, d) < EPS ||
      segmentDistance(b, c, d) < EPS ||
      segmentDistance(c, a, b) < EPS ||
      segmentDistance(d, a, b) < EPS)
  );
}
export function inRing(ring: readonly Point[], p: Point, boundary = true) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!,
      b = ring[j]!;
    if (segmentDistance(p, a, b) < EPS) return boundary;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
export function spawnRing(
  zone: Pick<SpawnZone, "x" | "y" | "width" | "height" | "polygon">,
): Point[] {
  return (
    zone.polygon ?? [
      { x: zone.x, y: zone.y },
      { x: zone.x + zone.width, y: zone.y },
      { x: zone.x + zone.width, y: zone.y + zone.height },
      { x: zone.x, y: zone.y + zone.height },
    ]
  );
}
export const spawnArea = (zone: SpawnZone) =>
  Math.abs(signedArea(spawnRing(zone))) -
  (zone.holes ?? []).reduce((n, ring) => n + Math.abs(signedArea(ring)), 0);
export function spawnContains(
  zone: SpawnZone,
  p: Point,
  radius = 0,
  boundary = true,
) {
  const outer = spawnRing(zone),
    holes = zone.holes ?? [];
  return (
    inRing(outer, p, boundary) &&
    !holes.some((h) => inRing(h, p, true)) &&
    [outer, ...holes].every((ring) =>
      ring.every(
        (a, i) =>
          segmentDistance(p, a, ring[(i + 1) % ring.length]!) + EPS >= radius,
      ),
    )
  );
}
function simple(ring: readonly Point[]) {
  return (
    ring.length >= 3 &&
    ring.length <= 512 &&
    Math.abs(signedArea(ring)) > EPS &&
    ring.every((p, i) => {
      const q = ring[(i + 1) % ring.length]!;
      return (
        Math.hypot(q.x - p.x, q.y - p.y) > EPS &&
        ring.every(
          (a, j) =>
            j === i ||
            j === (i + 1) % ring.length ||
            i === (j + 1) % ring.length ||
            !segmentsCross(p, q, a, ring[(j + 1) % ring.length]!),
        )
      );
    })
  );
}
export function spawnGeometryError(zone: SpawnZone): string | null {
  if (!zone.polygon)
    return zone.holes?.length
      ? "Spawn holes require a polygon boundary."
      : null;
  const rings = [zone.polygon, ...(zone.holes ?? [])];
  if (!rings.every(simple))
    return "Spawn polygons need simple, nonintersecting boundaries with at least three distinct vertices.";
  const bounds = polygonBounds(zone.polygon);
  if (
    (["x", "y", "width", "height"] as const).some(
      (k) => Math.abs(bounds[k] - zone[k]) > EPS,
    )
  )
    return "Spawn polygon bounds must match its vertices.";
  for (let i = 1; i < rings.length; i++) {
    const hole = rings[i]!;
    if (!hole.every((p) => inRing(zone.polygon!, p, false)))
      return "Spawn holes must lie strictly inside their polygon.";
    for (let j = 0; j < i; j++) {
      const other = rings[j]!;
      if (
        hole.some((a, k) =>
          other.some((b, l) =>
            segmentsCross(
              a,
              hole[(k + 1) % hole.length]!,
              b,
              other[(l + 1) % other.length]!,
            ),
          ),
        ) ||
        (j > 0 && (inRing(other, hole[0]!) || inRing(hole, other[0]!)))
      )
        return "Spawn holes must not touch or overlap other boundaries.";
    }
  }
  return null;
}
/** Positive-area overlap only: neighboring zones may share boundary edges. */
export function spawnZonesOverlap(a: SpawnZone, b: SpawnZone) {
  if (
    a.x >= b.x + b.width - EPS ||
    b.x >= a.x + a.width - EPS ||
    a.y >= b.y + b.height - EPS ||
    b.y >= a.y + a.height - EPS
  )
    return false;
  const ar = [spawnRing(a), ...(a.holes ?? [])],
    br = [spawnRing(b), ...(b.holes ?? [])];
  if (
    ar.some((r) =>
      r.some((p, i) =>
        br.some((s) =>
          s.some((q, j) =>
            segmentsCross(
              p,
              r[(i + 1) % r.length]!,
              q,
              s[(j + 1) % s.length]!,
              false,
            ),
          ),
        ),
      ),
    )
  )
    return true;
  return [
    [a, b],
    [b, a],
  ].some(([source, target]) =>
    [spawnRing(source!), ...(source!.holes ?? [])].some((r) =>
      r.some((p, i) => {
        if (spawnContains(target!, p, 0, false)) return true;
        const q = r[(i + 1) % r.length]!,
          length = Math.hypot(q.x - p.x, q.y - p.y);
        const offset = Math.min(length * 1e-4, 1e-6);
        return [-1, 1].some((sign) => {
          const sample = {
            x: (p.x + q.x) / 2 - ((sign * (q.y - p.y)) / length) * offset,
            y: (p.y + q.y) / 2 + ((sign * (q.x - p.x)) / length) * offset,
          };
          return (
            spawnContains(source!, sample, 0, false) &&
            spawnContains(target!, sample, 0, false)
          );
        });
      }),
    ),
  );
}

export function transformSpawn(
  zone: SpawnZone,
  transform: (p: Point) => Point,
): SpawnZone {
  const polygon = spawnRing(zone).map(transform);
  return {
    ...zone,
    ...polygonBounds(polygon),
    ...(zone.polygon ? { polygon } : {}),
    ...(zone.holes ? { holes: zone.holes.map((r) => r.map(transform)) } : {}),
  };
}
