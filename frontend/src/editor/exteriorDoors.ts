import type { BuildingScenario, Opening, Point } from "../types/simulation";

const EPSILON = 1e-6;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const subtract = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
const length = (p: Point) => Math.hypot(p.x, p.y);

interface WallPiece {
  from: number;
  to: number;
  start: number;
  end: number;
}
interface Face {
  vertices: number[];
  area: number;
  component: number;
}
const classifiers = new WeakMap<
  BuildingScenario["walls"],
  (opening: Opening) => boolean
>();

function contains(polygon: readonly Point[], point: Point) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!,
      b = polygon[j]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

/** Wall centrelines define architectural rooms, including across door/window
 * spans. The unbounded face is outdoors; workspace extents are never boundaries.
 */
function buildExteriorClassifier(building: BuildingScenario) {
  const walls = building.walls;
  const cuts = walls.map(() => [0, 1]);
  function add(index: number, fraction: number) {
    if (fraction >= -EPSILON && fraction <= 1 + EPSILON)
      cuts[index]!.push(Math.max(0, Math.min(1, fraction)));
  }
  for (let i = 0; i < walls.length; i++)
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i]!,
        b = walls[j]!,
        u = subtract(a.end, a.start),
        v = subtract(b.end, b.start),
        delta = subtract(b.start, a.start),
        determinant = cross(u, v);
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
        for (const [index, wall, points] of [
          [i, a, [b.start, b.end]],
          [j, b, [a.start, a.end]],
        ] as const) {
          const direction = subtract(wall.end, wall.start),
            magnitude = length(direction);
          if (magnitude <= EPSILON) continue;
          for (const point of points) {
            const relative = subtract(point, wall.start);
            if (Math.abs(cross(relative, direction)) / magnitude <= EPSILON)
              add(
                index,
                (relative.x * direction.x + relative.y * direction.y) /
                  (magnitude * magnitude),
              );
          }
        }
      }
    }

  const vertices: Point[] = [],
    indices = new Map<string, number>(),
    neighbors: Set<number>[] = [],
    pieces = new Map<string, WallPiece[]>();
  function vertex(point: Point) {
    const key = `${Math.round(point.x / EPSILON)},${Math.round(point.y / EPSILON)}`;
    let id = indices.get(key);
    if (id === undefined) {
      id = vertices.length;
      indices.set(key, id);
      vertices.push(point);
      neighbors.push(new Set());
    }
    return id;
  }
  walls.forEach((wall, index) => {
    const direction = subtract(wall.end, wall.start),
      magnitude = length(direction),
      fractions = [...new Set(cuts[index]!)].sort((a, b) => a - b),
      spans: WallPiece[] = [];
    for (let k = 1; k < fractions.length; k++) {
      const start = fractions[k - 1]!,
        end = fractions[k]!,
        at = (t: number) => ({
          x: wall.start.x + direction.x * t,
          y: wall.start.y + direction.y * t,
        }),
        from = vertex(at(start)),
        to = vertex(at(end));
      if (from === to) continue;
      neighbors[from]!.add(to);
      neighbors[to]!.add(from);
      spans.push({ from, to, start: start * magnitude, end: end * magnitude });
    }
    pieces.set(wall.id, spans);
  });

  const components = new Array<number>(vertices.length).fill(-1);
  for (let root = 0; root < vertices.length; root++) {
    if (components[root] !== -1) continue;
    const stack = [root];
    components[root] = root;
    while (stack.length) {
      const current = stack.pop()!;
      for (const next of neighbors[current]!)
        if (components[next] === -1) {
          components[next] = root;
          stack.push(next);
        }
    }
  }
  const ordered = neighbors.map((adjacent, index) =>
      [...adjacent].sort(
        (a, b) =>
          Math.atan2(
            vertices[a]!.y - vertices[index]!.y,
            vertices[a]!.x - vertices[index]!.x,
          ) -
          Math.atan2(
            vertices[b]!.y - vertices[index]!.y,
            vertices[b]!.x - vertices[index]!.x,
          ),
      ),
    ),
    faceAt = new Map<string, number>(),
    faces: Face[] = [];
  for (let from = 0; from < vertices.length; from++)
    for (const to of ordered[from]!) {
      if (faceAt.has(`${from}:${to}`)) continue;
      const polygon: number[] = [],
        id = faces.length;
      let a = from,
        b = to;
      do {
        const key = `${a}:${b}`;
        if (faceAt.has(key)) break;
        faceAt.set(key, id);
        polygon.push(a);
        const around = ordered[b]!,
          back = around.indexOf(a),
          next = around[(back + around.length - 1) % around.length]!;
        a = b;
        b = next;
      } while (a !== from || b !== to);
      const area =
        polygon.reduce(
          (sum, v, i) =>
            sum +
            cross(vertices[v]!, vertices[polygon[(i + 1) % polygon.length]!]!),
          0,
        ) / 2;
      faces.push({ vertices: polygon, area, component: components[from]! });
    }

  // A disconnected loop inside another component is an interior partition,
  // rather than a second unbounded exterior. Room-use metadata would be needed
  // to distinguish an enclosed courtyard from an enclosed room.
  const exteriorFaces = new Set(
    faces.flatMap((face, index) => {
      if (face.area >= -EPSILON) return [];
      const point = vertices[face.vertices[0]!]!;
      const enclosed = faces.some(
        (other) =>
          other.component !== face.component &&
          other.area > EPSILON &&
          contains(
            other.vertices.map((v) => vertices[v]!),
            point,
          ),
      );
      return enclosed ? [] : [index];
    }),
  );
  return (opening: Opening) => {
    const spans = pieces.get(opening.wall_id),
      end = opening.offset + opening.width;
    if (!spans || opening.width <= 0 || opening.offset < -EPSILON) return false;
    let covered = 0;
    for (const span of spans) {
      const overlap =
        Math.min(span.end, end) - Math.max(span.start, opening.offset);
      if (overlap <= EPSILON) continue;
      const left = faceAt.get(`${span.from}:${span.to}`)!,
        right = faceAt.get(`${span.to}:${span.from}`)!,
        leftOutside = exteriorFaces.has(left),
        rightOutside = exteriorFaces.has(right);
      if (
        leftOutside === rightOutside ||
        faces[leftOutside ? right : left]!.area <= EPSILON
      )
        return false;
      covered += overlap;
    }
    return covered >= opening.width - EPSILON;
  };
}

function exteriorClassifier(building: BuildingScenario) {
  let classify = classifiers.get(building.walls);
  if (!classify) {
    classify = buildExteriorClassifier(building);
    classifiers.set(building.walls, classify);
  }
  return classify;
}

/** True only when the complete opening joins an enclosed room to outdoors. */
export function isExteriorDoor(building: BuildingScenario, opening: Opening) {
  return exteriorClassifier(building)(opening);
}

/** Recompute door roles after wall/opening edits or importing a layout.
 * Stable opening IDs keep simulation schedules and selection references valid.
 */
export function reclassifyDoors(building: BuildingScenario): BuildingScenario {
  const exterior = exteriorClassifier(building),
    doors: Opening[] = [],
    exits: Opening[] = [];
  for (const opening of [...building.doors, ...building.exits])
    (exterior(opening) ? exits : doors).push(opening);
  if (
    doors.length === building.doors.length &&
    doors.every((opening, index) => opening === building.doors[index]) &&
    exits.every((opening, index) => opening === building.exits[index])
  )
    return building;
  const exitIds = new Set(exits.map((opening) => opening.id)),
    doorIds = new Set(doors.map((opening) => opening.id)),
    events = [...(building.opening_events ?? [])];
  for (const id of building.blocked_exit_ids)
    if (
      doorIds.has(id) &&
      !events.some((event) => event.step === 0 && event.opening_id === id)
    )
      events.unshift({ step: 0, opening_id: id, blocked: true });
  return {
    ...building,
    doors,
    exits,
    blocked_exit_ids: building.blocked_exit_ids.filter((id) => exitIds.has(id)),
    ...(building.opening_events || events.length
      ? { opening_events: events }
      : {}),
  };
}
