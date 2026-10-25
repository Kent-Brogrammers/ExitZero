import Ajv from "ajv";
import schema from "../../../shared/schemas/contracts.schema.json";
import type {
  BuildingScenario,
  Opening,
  Point,
  Wall,
} from "../types/simulation";

const validateShape = new Ajv({ allErrors: true }).compile<BuildingScenario>(
  schema,
);
export type Selection = {
  kind:
    | "walls"
    | "doors"
    | "exits"
    | "windows"
    | "spawn_zones"
    | "obstructions"
    | "stair_areas"
    | "tornado_zones";
  id: string;
};
export const distance = (a: Point, b: Point) =>
  Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
export const wallLength = (wall: Pick<Wall, "start" | "end">) =>
  distance(wall.start, wall.end);

export function project(point: Point, wall: Pick<Wall, "start" | "end">) {
  const length = wallLength(wall);
  const fraction =
    length === 0
      ? 0
      : clamp(
          ((point.x - wall.start.x) * (wall.end.x - wall.start.x) +
            (point.y - wall.start.y) * (wall.end.y - wall.start.y)) /
            (length * length),
          0,
          1,
        );
  const position = {
    x: wall.start.x + fraction * (wall.end.x - wall.start.x),
    y: wall.start.y + fraction * (wall.end.y - wall.start.y),
  };
  return {
    point: position,
    offset: fraction * length,
    distance: distance(point, position),
  };
}

export function openingSegment(opening: Opening, wall: Wall): [Point, Point] {
  const length = wallLength(wall);
  const at = (offset: number) => ({
    x: wall.start.x + ((wall.end.x - wall.start.x) * offset) / length,
    y: wall.start.y + ((wall.end.y - wall.start.y) * offset) / length,
  });
  return [at(opening.offset), at(opening.offset + opening.width)];
}

interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}
const overlaps = (a: Rectangle, b: Rectangle) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

function intersects(wall: Wall, rectangle: Rectangle) {
  const padding = wall.thickness / 2;
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  let enter = 0;
  let leave = 1;
  for (const [p, q] of [
    [-dx, wall.start.x - rectangle.x + padding],
    [dx, rectangle.x + rectangle.width + padding - wall.start.x],
    [-dy, wall.start.y - rectangle.y + padding],
    [dy, rectangle.y + rectangle.height + padding - wall.start.y],
  ] as [number, number][]) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false;
    } else {
      const ratio = q / p;
      if (p < 0) enter = Math.max(enter, ratio);
      else leave = Math.min(leave, ratio);
      if (enter > leave) return false;
    }
  }
  return true;
}

/** Drafts may omit exits and occupants; simulation requests must be ready. */
export function buildingError(
  value: unknown,
  requireReady = true,
): string | null {
  if (!validateShape(value)) {
    if (
      validateShape.errors?.some((error) =>
        error.instancePath.endsWith("/name"),
      )
    )
      return "Object names must be nonblank strings of at most 80 characters.";
    return "Layout JSON does not match the continuous-geometry contract. Check required fields and numeric ranges.";
  }
  const b = value;
  if (requireReady && (!b.exits.length || !b.spawn_zones.length))
    return "Add at least one exit and one spawn zone before running a simulation.";
  const ids = new Set<string>();
  for (const element of [
    ...b.walls,
    ...b.doors,
    ...b.exits,
    ...(b.windows ?? []),
    ...b.spawn_zones,
    ...b.obstructions,
    ...(b.stair_areas ?? []),
    ...(b.tornado_zones ?? []),
  ]) {
    if (ids.has(element.id)) return "Every layout element needs a unique ID.";
    ids.add(element.id);
  }
  const inside = (p: Point) =>
    p.x >= 0 && p.y >= 0 && p.x <= b.width && p.y <= b.height;
  for (const wall of b.walls) {
    if (!inside(wall.start) || !inside(wall.end) || wallLength(wall) < 0.1)
      return "Walls need endpoints inside the workspace and length of at least 0.1 m.";
  }
  const openings = [...b.doors, ...b.exits, ...(b.windows ?? [])];
  for (let index = 0; index < openings.length; index++) {
    const o = openings[index]!;
    const wall = b.walls.find((w) => w.id === o.wall_id);
    if (!wall || o.offset + o.width > wallLength(wall) + 1e-8)
      return "Every door, exit or window must fit along an existing wall.";
    if (
      openings
        .slice(0, index)
        .some(
          (other) =>
            other.wall_id === o.wall_id &&
            o.offset < other.offset + other.width - 1e-8 &&
            other.offset < o.offset + o.width - 1e-8,
        )
    )
      return "Doors, exits and windows on the same wall must not overlap.";
  }
  if (
    b.windows?.some(
      (w) =>
        w.emergency_escape && w.emergency_escape.clear_width_metres > w.width,
    )
  )
    return "A window's usable width must fit within its nominal width.";
  if (
    b.windows?.some(
      (w) =>
        w.emergency_escape &&
        [
          w.emergency_escape.preparation_seconds,
          w.emergency_escape.traversal_seconds,
        ].some((s) => Math.ceil(s / b.time_step_seconds) > 4294867295),
    )
  )
    return "Window timing must fit within 32-bit simulation ticks.";
  if (b.blocked_exit_ids.some((id) => !b.exits.some((exit) => exit.id === id)))
    return "Blocked exit IDs must reference existing exits.";
  const events = b.opening_events ?? [];
  const seenEvents = new Set<string>();
  for (const [index, event] of events.entries()) {
    const key = JSON.stringify([event.step, event.opening_id]);
    if (
      event.step >= b.max_steps ||
      ![...b.doors, ...b.exits].some((o) => o.id === event.opening_id) ||
      (index > 0 && events[index - 1]!.step > event.step) ||
      seenEvents.has(key)
    )
      return "Opening events must reference existing doors or exits, in step order before the run limit, once per opening per step.";
    seenEvents.add(key);
  }
  for (const rectangle of [
    ...b.obstructions,
    ...b.spawn_zones,
    ...(b.stair_areas ?? []),
    ...(b.tornado_zones ?? []),
  ]) {
    if (
      !inside(rectangle) ||
      !inside({
        x: rectangle.x + rectangle.width,
        y: rectangle.y + rectangle.height,
      })
    )
      return "Rectangles must fit inside the workspace.";
  }
  if (b.disaster && !inside(b.disaster.center))
    return "Place the disaster inside the workspace.";
  if (
    (b.tornado_zones ?? []).some(
      (zone) =>
        zone.width <= 2 * b.agent_radius || zone.height <= 2 * b.agent_radius,
    )
  )
    return "Tornado zones must be wider than one occupant.";
  if (
    requireReady &&
    b.disaster?.kind === "tornado" &&
    !b.tornado_zones?.length
  )
    return "Place a tornado zone before running a tornado simulation.";
  if (
    b.disaster?.dynamics?.enabled &&
    b.disaster.kind !== "tornado" &&
    b.disaster.dynamics.max_radius < b.disaster.radius
  )
    return "Maximum patch radius must be at least the initial radius.";
  if (requireReady && b.disaster?.kind === "tornado") {
    const danger = b.disaster;
    if (
      (b.tornado_zones ?? []).some(
        (zone) =>
          Math.hypot(
            clamp(danger.center.x, zone.x, zone.x + zone.width) -
              danger.center.x,
            clamp(danger.center.y, zone.y, zone.y + zone.height) -
              danger.center.y,
          ) <=
          danger.radius * 1.3 + b.agent_radius,
      )
    )
      return "Tornado zones must be outside the tornado exposure area.";
  }
  let population = 0;
  for (let index = 0; index < b.spawn_zones.length; index++) {
    const zone = b.spawn_zones[index]!;
    if (
      zone.width < 2 * b.agent_radius ||
      zone.height < 2 * b.agent_radius ||
      zone.count * Math.PI * b.agent_radius ** 2 > zone.width * zone.height
    )
      return "Spawn zones need enough area and width for the configured occupant discs.";
    if (
      b.spawn_zones.slice(0, index).some((other) => overlaps(zone, other)) ||
      b.obstructions.some((other) => overlaps(zone, other)) ||
      b.walls.some((wall) => intersects(wall, zone))
    )
      return "Spawn zones cannot overlap walls, obstructions, or other spawn zones.";
    population += zone.count;
  }
  if (population > 10000) return "Total population must not exceed 10,000.";
  return null;
}

export function removeElement(
  building: BuildingScenario,
  selection: Selection,
): BuildingScenario {
  const next = structuredClone(building);
  switch (selection.kind) {
    case "walls":
      next.walls = next.walls.filter((v) => v.id !== selection.id);
      break;
    case "doors":
      next.doors = next.doors.filter((v) => v.id !== selection.id);
      break;
    case "exits":
      next.exits = next.exits.filter((v) => v.id !== selection.id);
      break;
    case "windows":
      next.windows = (next.windows ?? []).filter((v) => v.id !== selection.id);
      break;
    case "spawn_zones":
      next.spawn_zones = next.spawn_zones.filter((v) => v.id !== selection.id);
      break;
    case "tornado_zones":
      next.tornado_zones = (next.tornado_zones ?? []).filter(
        (v) => v.id !== selection.id,
      );
      break;
    case "stair_areas":
      next.stair_areas = (next.stair_areas ?? []).filter(
        (v) => v.id !== selection.id,
      );
      break;
    case "obstructions":
      next.obstructions = next.obstructions.filter(
        (v) => v.id !== selection.id,
      );
      break;
  }
  if (selection.kind === "walls") {
    next.doors = next.doors.filter((o) => o.wall_id !== selection.id);
    next.exits = next.exits.filter((o) => o.wall_id !== selection.id);
    if (next.windows)
      next.windows = next.windows.filter((o) => o.wall_id !== selection.id);
  }
  next.blocked_exit_ids = next.blocked_exit_ids.filter((id) =>
    next.exits.some((o) => o.id === id),
  );
  if (next.opening_events)
    next.opening_events = next.opening_events.filter((event) =>
      [...next.doors, ...next.exits].some((o) => o.id === event.opening_id),
    );
  return next;
}

export function translateElement(
  building: BuildingScenario,
  selection: Selection,
  delta: Point,
): BuildingScenario {
  const next = structuredClone(building);
  if (selection.kind === "walls") {
    const wall = next.walls.find((v) => v.id === selection.id)!;
    const dx = clamp(
      delta.x,
      -Math.min(wall.start.x, wall.end.x),
      next.width - Math.max(wall.start.x, wall.end.x),
    );
    const dy = clamp(
      delta.y,
      -Math.min(wall.start.y, wall.end.y),
      next.height - Math.max(wall.start.y, wall.end.y),
    );
    wall.start = { x: wall.start.x + dx, y: wall.start.y + dy };
    wall.end = { x: wall.end.x + dx, y: wall.end.y + dy };
  } else if (
    selection.kind === "doors" ||
    selection.kind === "exits" ||
    selection.kind === "windows"
  ) {
    const opening = (next[selection.kind] ?? []).find(
      (v) => v.id === selection.id,
    )!;
    const wall = next.walls.find((v) => v.id === opening.wall_id)!;
    const [a, b] = openingSegment(opening, wall);
    opening.offset = clamp(
      project(
        { x: (a.x + b.x) / 2 + delta.x, y: (a.y + b.y) / 2 + delta.y },
        wall,
      ).offset -
        opening.width / 2,
      0,
      wallLength(wall) - opening.width,
    );
  } else {
    const rectangle = (next[selection.kind] ?? []).find(
      (v) => v.id === selection.id,
    )!;
    rectangle.x = clamp(rectangle.x + delta.x, 0, next.width - rectangle.width);
    rectangle.y = clamp(
      rectangle.y + delta.y,
      0,
      next.height - rectangle.height,
    );
  }
  return next;
}

export function canvasView(
  width: number,
  height: number,
  building: BuildingScenario,
) {
  const scale = Math.min(width / building.width, height / building.height);
  return {
    scale,
    x: (width - building.width * scale) / 2,
    y: (height - building.height * scale) / 2,
  };
}
