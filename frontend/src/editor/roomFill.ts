import type { BuildingScenario, Point, SpawnZone } from "../types/simulation";
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
