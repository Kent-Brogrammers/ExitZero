import type {
  BuildingScenario,
  Point,
  SpawnZone,
  Wall,
} from "../types/simulation";
import { buildingError, project } from "./geometry";
import { nextObjectName } from "./names";
import { buildingFaces } from "./topology";
import {
  inRing,
  polygonBounds,
  segmentDistance,
  spawnContains,
  spawnRing,
  spawnZonesOverlap,
  segmentsCross,
} from "./spawnGeometry";
import type { Bounds } from "./selection";
export interface Room {
  point: Point;
  boundary: Point[];
  holes: Point[][];
  bounds: Bounds;
  spawnIds: string[];
}
export function roomContains(room: Room, p: Point) {
  return inRing(room.boundary, p) && !room.holes.some((h) => inRing(h, p));
}
export function detectRoom(building: BuildingScenario, point: Point): Room {
  if (
    building.walls.some(
      (w) => project(point, w).distance <= w.thickness / 2 + 0.0001,
    )
  )
    throw new Error(
      "Click on floor space inside the room, away from its walls.",
    );
  const all = buildingFaces(building),
    face = all.find((f) => inRing(f.points, point));
  if (!face)
    throw new Error(
      "No enclosed room found. Connect the surrounding wall endpoints, then click inside. Door and window spans count as boundaries.",
    );
  const nested = all.filter(
    (f) =>
      f.area < face.area &&
      f.points.every((p) => inRing(face.points, p, false)),
  );
  const holes = nested
    .filter(
      (f) =>
        !nested.some(
          (other) =>
            other !== f &&
            other.area > f.area &&
            f.points.every((p) => inRing(other.points, p)),
        ),
    )
    .map((f) => f.points);
  const room: Room = {
    point,
    boundary: face.points,
    holes,
    bounds: polygonBounds(face.points),
    spawnIds: [],
  };
  const region: SpawnZone = {
    id: "room-outline",
    ...room.bounds,
    polygon: room.boundary,
    holes: room.holes,
    count: 1,
  };
  room.spawnIds = building.spawn_zones
    .filter((z) => spawnZonesOverlap(z, region))
    .map((z) => z.id);
  return room;
}
/** IDs retain the editor-only group association through ordinary JSON round trips. */
export function roomFillGroup(id: string): string | null {
  return /^roomfill_([a-zA-Z0-9-]+)_\d+$/.exec(id)?.[1] ?? null;
}
export function roomFillZones(
  building: BuildingScenario,
  id: string,
): SpawnZone[] {
  const group = roomFillGroup(id);
  return group
    ? building.spawn_zones.filter((z) => roomFillGroup(z.id) === group)
    : [];
}

/** Wall edits invalidate retained automatic room fills; manual spawns remain independent. */
export function invalidateRoomFills(
  before: BuildingScenario,
  next: BuildingScenario,
): BuildingScenario {
  const oldWalls = new Map(before.walls.map((w) => [w.id, w]));
  const newWalls = new Map(next.walls.map((w) => [w.id, w]));
  const changed: Wall[] = [];
  for (const id of new Set([...oldWalls.keys(), ...newWalls.keys()])) {
    const old = oldWalls.get(id),
      current = newWalls.get(id);
    if (!old || !current) {
      changed.push((old ?? current)!);
      continue;
    }
    const dx = old.end.x - old.start.x,
      dy = old.end.y - old.start.y;
    const length = Math.hypot(dx, dy);
    const collinear = (p: Point) =>
      Math.abs((p.x - old.start.x) * dy - (p.y - old.start.y) * dx) <=
      1e-8 * length;
    if (
      length > 0 &&
      old.thickness === current.thickness &&
      collinear(current.start) &&
      collinear(current.end)
    ) {
      // A shortened/extended wall changes only its end portions, not every
      // room bordering the unchanged span of that same wall.
      const at = (p: Point) =>
        ((p.x - old.start.x) * dx + (p.y - old.start.y) * dy) / length;
      const [lo, hi] = [at(current.start), at(current.end)].sort(
        (a, b) => a - b,
      );
      const points = [...new Set([0, length, lo!, hi!])].sort((a, b) => a - b);
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!,
          b = points[i]!,
          middle = (a + b) / 2;
        if (
          (middle >= 0 && middle <= length) === (middle >= lo! && middle <= hi!)
        )
          continue;
        const point = (t: number) => ({
          x: old.start.x + (t * dx) / length,
          y: old.start.y + (t * dy) / length,
        });
        changed.push({ ...old, start: point(a), end: point(b) });
      }
    } else changed.push(old, current);
  }
  if (!changed.length) return next;
  const invalid = new Set<string>();
  for (const zone of before.spawn_zones) {
    const group = roomFillGroup(zone.id);
    if (!group) continue;
    const rings = [spawnRing(zone), ...(zone.holes ?? [])];
    if (
      changed.some(
        (wall) =>
          spawnContains(zone, wall.start) ||
          spawnContains(zone, wall.end) ||
          rings.some((ring) =>
            ring.some((a, i) => {
              const b = ring[(i + 1) % ring.length]!;
              return (
                segmentsCross(a, b, wall.start, wall.end) ||
                Math.min(
                  segmentDistance(a, wall.start, wall.end),
                  segmentDistance(b, wall.start, wall.end),
                  segmentDistance(wall.start, a, b),
                  segmentDistance(wall.end, a, b),
                ) <=
                  wall.thickness / 2 + 1e-6
              );
            }),
          ),
      )
    )
      invalid.add(group);
  }
  if (!invalid.size) return next;
  return {
    ...next,
    spawn_zones: next.spawn_zones.filter(
      (zone) => !invalid.has(roomFillGroup(zone.id) ?? ""),
    ),
  };
}

/** One persisted polygon per room. This conservative floor-space sample only estimates an editable population limit. */
export function populateRoom(
  building: BuildingScenario,
  room: Room,
  count: number,
  group: string = crypto.randomUUID(),
  replaceIds = room.spawnIds,
): { building: BuildingScenario; ids: string[] } {
  if (!Number.isInteger(count) || count < 1 || count > 10000)
    throw new Error("Choose a whole number from 1 to 10,000 occupants.");
  const remaining = building.spawn_zones.filter(
    (z) => !replaceIds.includes(z.id),
  );
  const id = `roomfill_${group}_0`;
  const zone: SpawnZone = {
    ...polygonBounds(room.boundary),
    id,
    name:
      building.spawn_zones.find((z) => z.id === id)?.name ??
      nextObjectName(
        { ...building, spawn_zones: remaining },
        "spawn_zones",
        "Room fill",
      ),
    count,
    polygon: structuredClone(room.boundary),
    ...(room.holes.length ? { holes: structuredClone(room.holes) } : {}),
  };
  const r = building.agent_radius,
    pitch = 2.25 * r * 2,
    dx = Math.max(pitch, zone.width / 128),
    dy = Math.max(pitch, zone.height / 128);
  let capacity = 0;
  for (
    let y = zone.y + r;
    y <= zone.y + zone.height - r && capacity < 10000;
    y += dy
  )
    for (
      let x = zone.x + r;
      x <= zone.x + zone.width - r && capacity < 10000;
      x += dx
    ) {
      const p = { x, y };
      if (
        spawnContains(zone, p, r) &&
        !building.walls.some(
          (w) => segmentDistance(p, w.start, w.end) < r + w.thickness / 2,
        ) &&
        !building.obstructions.some(
          (o) =>
            Math.hypot(
              x - Math.max(o.x, Math.min(x, o.x + o.width)),
              y - Math.max(o.y, Math.min(y, o.y + o.height)),
            ) < r,
        ) &&
        !(building.placed_occupants ?? []).some(
          (person) => Math.hypot(person.x - p.x, person.y - p.y) < 2 * r,
        ) &&
        !remaining.some((z) => spawnContains(z, p))
      )
        capacity++;
      if (capacity >= 10000) break;
    }
  if (count > capacity)
    throw new Error(
      `Could not fit ${count} occupants with clearance. This fill supports up to ${capacity}; reduce the count or clear furniture.`,
    );
  const next = { ...building, spawn_zones: [...remaining, zone] };
  const problem = buildingError(next, false);
  if (problem) throw new Error(problem);
  return { building: next, ids: [zone.id] };
}
export function resizeRoomPopulation(
  building: BuildingScenario,
  id: string,
  count: number,
) {
  const zones = roomFillZones(building, id),
    selected = zones.find((z) => z.id === id);
  if (!selected) throw new Error("Select a room-fill area first.");
  // Population edits preserve the exact saved polygon, including concave rooms and holes.
  if (selected.polygon && zones.length === 1) {
    const next = {
      ...building,
      spawn_zones: building.spawn_zones.map((z) =>
        z.id === id ? { ...z, count } : z,
      ),
    };
    const problem = buildingError(next, false);
    if (problem) throw new Error(problem);
    return { building: next, ids: [id] };
  }
  const seed = spawnRing(selected).find((p) =>
    building.walls.every(
      (w) => project(p, w).distance > w.thickness / 2 + 0.001,
    ),
  ) ?? {
    x: selected.x + selected.width / 2,
    y: selected.y + selected.height / 2,
  };
  return populateRoom(
    building,
    detectRoom(building, seed),
    count,
    roomFillGroup(id)!,
    zones.map((z) => z.id),
  );
}
