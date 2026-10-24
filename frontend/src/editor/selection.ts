import type { BuildingScenario, Point } from "../types/simulation";
import {
  clamp,
  openingSegment,
  project,
  wallLength,
  type Selection,
} from "./geometry";
export const elementKinds = [
  "walls",
  "doors",
  "exits",
  "spawn_zones",
  "obstructions",
  "stair_areas",
] as const;
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const sameSelection = (a: Selection, b: Selection) =>
  a.kind === b.kind && a.id === b.id;
export function combineSelection(
  a: readonly Selection[],
  b: readonly Selection[],
): Selection[] {
  return [...a, ...b.filter((s) => !a.some((item) => sameSelection(s, item)))];
}
export function toggleSelection(
  items: readonly Selection[],
  item: Selection,
): Selection[] {
  return items.some((s) => sameSelection(s, item))
    ? items.filter((s) => !sameSelection(s, item))
    : [...items, item];
}
export function elementBounds(
  b: BuildingScenario,
  s: Selection,
  footprint = false,
): Bounds | null {
  const element = (b[s.kind] ?? []).find((e) => e.id === s.id);
  if (!element) return null;
  if ("x" in element)
    return {
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    };
  const wall =
    "start" in element
      ? element
      : b.walls.find((w) => w.id === element.wall_id);
  if (!wall) return null;
  const [a, c] =
    "start" in element
      ? [element.start, element.end]
      : openingSegment(element, wall);
  const pad = footprint ? wall.thickness / 2 : 0;
  return {
    x: Math.min(a.x, c.x) - pad,
    y: Math.min(a.y, c.y) - pad,
    width: Math.abs(a.x - c.x) + pad * 2,
    height: Math.abs(a.y - c.y) + pad * 2,
  };
}
export function selectionBounds(
  b: BuildingScenario,
  items: readonly Selection[],
  footprint = false,
): Bounds | null {
  const bounds = items
    .map((s) => elementBounds(b, s, footprint))
    .filter((r): r is Bounds => r !== null);
  if (!bounds.length) return null;
  const x = Math.min(...bounds.map((r) => r.x)),
    y = Math.min(...bounds.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...bounds.map((r) => r.x + r.width)) - x,
    height: Math.max(...bounds.map((r) => r.y + r.height)) - y,
  };
}
/** Containment rule: the entire footprint visible within workspace extents must fit. */
export function marqueeSelection(b: BuildingScenario, r: Bounds): Selection[] {
  const result: Selection[] = [];
  for (const kind of elementKinds)
    for (const item of b[kind] ?? []) {
      const s = { kind, id: item.id },
        raw = elementBounds(b, s, true)!;
      const left = Math.max(0, raw.x),
        top = Math.max(0, raw.y);
      const bounds = {
        x: left,
        y: top,
        width: Math.min(b.width, raw.x + raw.width) - left,
        height: Math.min(b.height, raw.y + raw.height) - top,
      };
      if (
        bounds.x >= r.x - 1e-8 &&
        bounds.y >= r.y - 1e-8 &&
        bounds.x + bounds.width <= r.x + r.width + 1e-8 &&
        bounds.y + bounds.height <= r.y + r.height + 1e-8
      )
        result.push(s);
    }
  return result;
}
export function removeSelection(
  b: BuildingScenario,
  items: readonly Selection[],
): BuildingScenario {
  const next = structuredClone(b),
    removed = new Set(items.map((s) => s.id));
  for (const kind of elementKinds)
    if (next[kind])
      Object.assign(next, {
        [kind]: next[kind]!.filter((e) => !removed.has(e.id)),
      });
  const walls = new Set(next.walls.map((w) => w.id));
  next.doors = next.doors.filter((o) => walls.has(o.wall_id));
  next.exits = next.exits.filter((o) => walls.has(o.wall_id));
  next.blocked_exit_ids = next.blocked_exit_ids.filter((id) =>
    next.exits.some((o) => o.id === id),
  );
  if (next.opening_events)
    next.opening_events = next.opening_events.filter((event) =>
      [...next.doors, ...next.exits].some((o) => o.id === event.opening_id),
    );
  return next;
}
/** Apply one vector atomically. Selected parent walls carry their openings exactly once. */
export function moveSelection(
  b: BuildingScenario,
  items: readonly Selection[],
  delta: Point,
): BuildingScenario {
  const next = structuredClone(b),
    walls = new Set(items.filter((s) => s.kind === "walls").map((s) => s.id));
  for (const s of items) {
    const e = (next[s.kind] ?? []).find((v) => v.id === s.id);
    if (!e) continue;
    if ("start" in e) {
      e.start = { x: e.start.x + delta.x, y: e.start.y + delta.y };
      e.end = { x: e.end.x + delta.x, y: e.end.y + delta.y };
    } else if ("wall_id" in e) {
      if (walls.has(e.wall_id)) continue;
      const wall = b.walls.find((w) => w.id === e.wall_id)!;
      const [a, c] = openingSegment(e, wall);
      e.offset = clamp(
        project(
          { x: (a.x + c.x) / 2 + delta.x, y: (a.y + c.y) / 2 + delta.y },
          wall,
        ).offset -
          e.width / 2,
        0,
        wallLength(wall) - e.width,
      );
    } else {
      e.x += delta.x;
      e.y += delta.y;
    }
  }
  return next;
}
export function canResizeSelection(
  b: BuildingScenario,
  items: readonly Selection[],
): boolean {
  const walls = new Set(
    items.filter((s) => s.kind === "walls").map((s) => s.id),
  );
  return items.every((s) => {
    const e = (b[s.kind] ?? []).find((v) => v.id === s.id);
    return e && (!("wall_id" in e) || walls.has(e.wall_id));
  });
}
/** Scale centreline/rectangle bounds; wall thickness and population remain unchanged. */
export function resizeSelection(
  b: BuildingScenario,
  items: readonly Selection[],
  width: number,
  height: number,
): BuildingScenario {
  const bounds = selectionBounds(b, items);
  if (!bounds || !canResizeSelection(b, items)) return b;
  const sx = bounds.width ? width / bounds.width : 1,
    sy = bounds.height ? height / bounds.height : 1;
  const transform = (p: Point) => ({
    x: bounds.x + (p.x - bounds.x) * sx,
    y: bounds.y + (p.y - bounds.y) * sy,
  });
  const next = structuredClone(b),
    walls = new Set(items.filter((s) => s.kind === "walls").map((s) => s.id));
  for (const s of items) {
    const e = (next[s.kind] ?? []).find((v) => v.id === s.id);
    if (!e) continue;
    if ("start" in e) {
      e.start = transform(e.start);
      e.end = transform(e.end);
    } else if (!("wall_id" in e)) {
      const p = transform(e);
      e.x = p.x;
      e.y = p.y;
      e.width *= sx;
      e.height *= sy;
    }
  }
  for (const o of [...next.doors, ...next.exits])
    if (walls.has(o.wall_id)) {
      const ratio =
        wallLength(next.walls.find((w) => w.id === o.wall_id)!) /
        wallLength(b.walls.find((w) => w.id === o.wall_id)!);
      o.offset *= ratio;
      o.width *= ratio;
    }
  return next;
}
