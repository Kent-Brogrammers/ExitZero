import type { BuildingScenario, Point, SpawnZone } from "../types/simulation";
import {
  buildingError,
  distance,
  project,
} from "./geometry";
import { nextObjectName } from "./names";
import type { Bounds } from "./selection";
import { roomSpawnCapacity, zoneContainsPoint } from "./spawnGeometry";

const EPSILON = 1e-6;
const GAP = 0.0001;
interface Face {
  points: Point[];
  area: number;
  inset: number;
}
export interface Room {
  point: Point;
  boundary: Point[];
  holes: Point[][];
  bounds: Bounds;
  spawnIds: string[];
}

const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const subtract = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
function contains(polygon: readonly Point[], p: Point) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!,
      b = polygon[j]!;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
export function roomContains(room: Room, p: Point) {
  return (
    contains(room.boundary, p) && !room.holes.some((hole) => contains(hole, p))
  );
}

/** Architectural faces use full parent walls: doors/windows still divide rooms.
 * Split at T/cross intersections; walk the bounded faces of the planar graph.
 * This is editor topology only, not simulation routing or movement.
 */
function faces(building: BuildingScenario): Face[] {
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
      const area =
        polygon.reduce(
          (sum, p, i) => sum + cross(p, polygon[(i + 1) % polygon.length]!),
          0,
        ) / 2;
      if (a === from && b === to && area > EPSILON)
        result.push({ points: polygon, area, inset });
    }
  return result.sort((a, b) => a.area - b.area);
}

export function detectRoom(building: BuildingScenario, point: Point): Room {
  if (
    building.walls.some(
      (wall) => project(point, wall).distance <= wall.thickness / 2 + GAP,
    )
  )
    throw new Error(
      "Click on floor space inside the room, away from its walls.",
    );
  const all = faces(building),
    face = all.find((f) => contains(f.points, point));
  if (!face)
    throw new Error(
      "No enclosed room found. Connect the surrounding wall endpoints, then click inside. Door and window spans count as boundaries.",
    );
  const xs = face.points.map((p) => p.x),
    ys = face.points.map((p) => p.y);
  const room: Room = {
    point,
    boundary: face.points,
    holes: all.filter((f) => f.area < face.area && f.points.every((p) => contains(face.points, p))).filter((f, _, candidates) => !candidates.some((other) => other.area > f.area && f.points.every((p) => contains(other.points, p)))).map((f) => f.points),
    bounds: {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    },
    spawnIds: [],
  };
  room.spawnIds = building.spawn_zones
    .filter((zone) =>
      zone.polygon
        ? zone.polygon.boundary.every((p) => face.points.some((q) => distance(p,q) < EPSILON))
        : roomContains(room, { x: zone.x + zone.width / 2, y: zone.y + zone.height / 2 }),
    )
    .map((zone) => zone.id);
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

export function populateRoom(
  building: BuildingScenario,
  room: Room,
  count: number,
  group: string = crypto.randomUUID(),
  replaceIds = room.spawnIds,
): { building: BuildingScenario; ids: string[] } {
  if (!Number.isInteger(count) || count < 1 || count > 10000)
    throw new Error("Choose a whole number from 1 to 10,000 occupants.");
  const replace = new Set(replaceIds),
    remaining = building.spawn_zones.filter((z) => !replace.has(z.id));
  const base = { ...building, spawn_zones: remaining };
  const id = `roomfill_${group}_0`;
  const added: SpawnZone[] = [{
    ...room.bounds,
    id,
    name: building.spawn_zones.find((z) => z.id === id)?.name ?? nextObjectName(base, "spawn_zones", "Room fill"),
    polygon: {
      boundary: structuredClone(room.boundary),
      ...(room.holes.length ? { holes: structuredClone(room.holes) } : {}),
    },
    count,
  }];
  const capacity = roomSpawnCapacity(base, added[0]!);
  if (count > capacity)
    throw new Error(
      `Could not fit ${count} occupants with clearance. This fill supports up to ${capacity}; reduce the count, clear furniture, or remove unused spawn zones.`,
    );
  const next = { ...building, spawn_zones: [...remaining, ...added] };
  const problem = buildingError(next, false);
  if (problem) throw new Error(problem);
  return { building: next, ids: added.map((z) => z.id) };
}

export function resizeRoomPopulation(
  building: BuildingScenario,
  id: string,
  count: number,
) {
  const zones = roomFillZones(building, id),
    selected = zones.find((z) => z.id === id);
  if (!selected) throw new Error("Select a room-fill area first.");
  // A concave polygon's bounding-box centre may lie outside its room.
  let point = { x: selected.x + selected.width / 2, y: selected.y + selected.height / 2 };
  if (!zoneContainsPoint(selected, point)) {
    let found = false;
    for (let row = 1; row < 40 && !found; row++) for (let col = 1; col < 40; col++) {
      const p = { x: selected.x + selected.width * col / 40, y: selected.y + selected.height * row / 40 };
      if (zoneContainsPoint(selected, p) && !building.walls.some((w) => project(p, w).distance <= w.thickness / 2 + GAP)) { point = p; found = true; break; }
    }
  }
  const room = detectRoom(building, point);
  return populateRoom(
    building,
    room,
    count,
    roomFillGroup(id)!,
    zones.map((z) => z.id),
  );
}
