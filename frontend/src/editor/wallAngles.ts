import type { Point } from "../types/simulation";

const directions = [
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
] as const;
function direction(start: Point, pointer: Point) {
  const index = Math.round(
    Math.atan2(pointer.y - start.y, pointer.x - start.x) / (Math.PI / 4),
  );
  return directions[(index + 8) % 8]!;
}

/** A Shift-constrained endpoint may only snap along the chosen forward ray. */
export function isOnLockedWallAngle(
  start: Point,
  pointer: Point,
  target: Point,
): boolean {
  const d = direction(start, pointer);
  const dx = target.x - start.x,
    dy = target.y - start.y;
  return dx * d.x + dy * d.y >= 0 && Math.abs(dx * d.y - dy * d.x) <= 1e-8;
}

/** Closest 45-degree ray; grid rounding changes distance without bending it. */
export function constrainWallEnd(
  start: Point,
  pointer: Point,
  bounds: { width: number; height: number },
  gridSpacing?: number,
): Point {
  const d = direction(start, pointer);
  const dx = pointer.x - start.x,
    dy = pointer.y - start.y;
  let amount = (dx * d.x + dy * d.y) / (d.x * d.x + d.y * d.y);
  if (gridSpacing && Number.isFinite(gridSpacing) && gridSpacing > 0) {
    const origin = d.x ? start.x : start.y;
    const sign = d.x || d.y;
    amount =
      (Math.round((origin + amount * sign) / gridSpacing) * gridSpacing -
        origin) /
      sign;
  }
  const limit = Math.min(
    d.x > 0 ? bounds.width - start.x : d.x < 0 ? start.x : Infinity,
    d.y > 0 ? bounds.height - start.y : d.y < 0 ? start.y : Infinity,
  );
  amount = Math.max(0, Math.min(limit, amount));
  // Preserve already aligned snap targets exactly on preview/serialization.
  if (
    !gridSpacing &&
    pointer.x >= 0 &&
    pointer.y >= 0 &&
    pointer.x <= bounds.width &&
    pointer.y <= bounds.height &&
    isOnLockedWallAngle(start, pointer, pointer)
  )
    return { ...pointer };
  return { x: start.x + d.x * amount, y: start.y + d.y * amount };
}
