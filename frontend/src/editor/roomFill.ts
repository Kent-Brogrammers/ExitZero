import type { BuildingScenario, Point, SpawnZone } from "../types/simulation";
import {
  buildingError,
  distance,
  project,
  rectanglesOverlap,
  wallIntersectsRectangle,
} from "./geometry";
import { nextObjectName } from "./names";
import type { Bounds } from "./selection";

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
    holes: all.filter((f) => f.area < face.area).map((f) => f.points),
    bounds: {
      x: Math.min(...xs) + face.inset,
      y: Math.min(...ys) + face.inset,
      width: Math.max(...xs) - Math.min(...xs) - 2 * face.inset,
      height: Math.max(...ys) - Math.min(...ys) - 2 * face.inset,
    },
    spawnIds: [],
  };
  room.spawnIds = building.spawn_zones
    .filter((zone) =>
      roomContains(room, {
        x: zone.x + zone.width / 2,
        y: zone.y + zone.height / 2,
      }),
    )
    .map((zone) => zone.id);
  return room;
}

/** Conservative temporary subdivision, merged into ordinary continuous rectangles.
 * Only complete clear rectangles are saved; no grid or room fields enter the API.
 */
function freeAreas(
  building: BuildingScenario,
  room: Room,
  replace: Set<string>,
) {
  const bounds = room.bounds,
    diameter = 2 * building.agent_radius;
  if (Math.min(bounds.width, bounds.height) < diameter + 2 * GAP) return [];
  const pitch = Math.max(
    diameter + 4 * GAP,
    Math.sqrt((bounds.width * bounds.height) / 1600),
  );
  const nx = Math.max(1, Math.min(64, Math.floor(bounds.width / pitch)));
  const ny = Math.max(1, Math.min(64, Math.floor(bounds.height / pitch)));
  const dx = bounds.width / nx,
    dy = bounds.height / ny;
  const barriers = [
    ...building.obstructions,
    ...building.spawn_zones.filter((z) => !replace.has(z.id)),
  ];
  const cells = Array.from({ length: ny }, (_, row) =>
    Array.from({ length: nx }, (_, col) => {
      const r = {
        x: bounds.x + col * dx,
        y: bounds.y + row * dy,
        width: dx,
        height: dy,
      };
      return (
        [
          r,
          { x: r.x + dx, y: r.y },
          { x: r.x, y: r.y + dy },
          { x: r.x + dx, y: r.y + dy },
        ].every((p) => roomContains(room, p)) &&
        roomContains(room, { x: r.x + dx / 2, y: r.y + dy / 2 }) &&
        !building.walls.some((wall) => wallIntersectsRectangle(wall, r)) &&
        !barriers.some((barrier) => rectanglesOverlap(r, barrier))
      );
    }),
  );
  const areas: Bounds[] = [];
  for (let row = 0; row < ny; row++)
    for (let col = 0; col < nx; col++) {
      if (!cells[row]![col]) continue;
      let width = 1,
        height = 1;
      while (col + width < nx && cells[row]![col + width]) width++;
      while (
        row + height < ny &&
        cells[row + height]!.slice(col, col + width).every(Boolean)
      )
        height++;
      for (let y = row; y < row + height; y++)
        for (let x = col; x < col + width; x++) cells[y]![x] = false;
      areas.push({
        x: bounds.x + col * dx + GAP,
        y: bounds.y + row * dy + GAP,
        width: width * dx - 2 * GAP,
        height: height * dy - 2 * GAP,
      });
    }
  return areas
    .filter((r) => Math.min(r.width, r.height) >= diameter)
    .sort((a, b) => b.width * b.height - a.width * a.height);
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
  const areas = freeAreas(building, room, replace).slice(
    0,
    Math.max(0, 100 - remaining.length),
  );
  const diameter = building.agent_radius * 2;
  // Leave generous room for Rust's bounded random sampler, rather than relying
  // on the schema's loose disc-area bound as a claim of packing feasibility.
  const capacities = areas.map(
    (r) =>
      (Math.floor((r.width - diameter) / (2.25 * diameter)) + 1) *
      (Math.floor((r.height - diameter) / (2.25 * diameter)) + 1),
  );
  const capacity = capacities.reduce((sum, n) => sum + n, 0);
  if (count > capacity)
    throw new Error(
      `Could not fit ${count} occupants with clearance. This fill supports up to ${capacity}; reduce the count, clear furniture, or remove unused spawn zones.`,
    );
  let random =
    ((building.seed % 4294967296) ^
      Math.floor(building.seed / 4294967296) ^
      0x9e3779b9) >>>
    0;
  const counts = areas.map(() => 0);
  for (let n = 0; n < count; n++) {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    const weights = areas.map(
      (r, i) => r.width * r.height * (1 - counts[i]! / capacities[i]!),
    );
    let pick =
      ((random >>> 0) / 4294967296) *
      weights.reduce((sum, weight) => sum + weight, 0);
    let chosen = weights.findIndex((weight) => {
      pick -= weight;
      return weight > 0 && pick < 0;
    });
    if (chosen < 0)
      chosen = capacities.findIndex((limit, i) => counts[i]! < limit);
    counts[chosen] = counts[chosen]! + 1;
  }
  const base = { ...building, spawn_zones: remaining };
  const name = nextObjectName(base, "spawn_zones", "Room fill");
  const added = areas.flatMap((area, i): SpawnZone[] =>
    counts[i]
      ? [
          {
            ...area,
            id: `roomfill_${group}_${i}`,
            count: counts[i]!,
            name:
              building.spawn_zones.find(
                (z) => z.id === `roomfill_${group}_${i}`,
              )?.name ?? `${name} · Area ${i + 1}`,
          },
        ]
      : [],
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
  const room = detectRoom(building, {
    x: selected.x + selected.width / 2,
    y: selected.y + selected.height / 2,
  });
  if (
    zones.some(
      (z) =>
        !roomContains(room, { x: z.x + z.width / 2, y: z.y + z.height / 2 }),
    )
  )
    throw new Error(
      "These spawn areas have moved into different rooms. Use Fill Room again to configure each room.",
    );
  return populateRoom(
    building,
    room,
    count,
    roomFillGroup(id)!,
    zones.map((z) => z.id),
  );
}
