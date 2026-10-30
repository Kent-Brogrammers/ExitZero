import { formatLength } from "../utils/units";
import type {
  BuildingScenario,
  Point,
  Wall,
  WindowFrameState,
  WindowOpening,
} from "../types/simulation";
import { openingSegment, wallLength, project, distance } from "./geometry";
import { openingStartsBlocked } from "./openingState";
import type { MeasurementVisibility } from "./measurements";

// Match Rust and the shared opening bounds/overlap tolerance, in metres.
const OPENING_EPSILON = 1e-8;

/** Playback-only door states; never part of the saved building contract. */
export type OpeningLayout = BuildingScenario & {
  closedDoorIds?: readonly string[];
};

/** Suggest an exterior only when all occupied spawn rectangles lie on one side.
 * This is a setup hint, not a topology or outdoor-clearance check. */
export function suggestedWindowExterior(
  building: BuildingScenario,
  pane: WindowOpening,
): -1 | 1 | null {
  const wall = building.walls.find((w) => w.id === pane.wall_id);
  if (!wall) return null;
  const length = wallLength(wall);
  if (length <= 0) return null;
  const nx = -(wall.end.y - wall.start.y) / length,
    ny = (wall.end.x - wall.start.x) / length;
  let occupiedSide = 0;
  for (const zone of building.spawn_zones.filter((z) => z.count > 0)) {
    for (const x of [zone.x, zone.x + zone.width]) {
      for (const y of [zone.y, zone.y + zone.height]) {
        const distance = (x - wall.start.x) * nx + (y - wall.start.y) * ny;
        const side = Math.sign(distance);
        if (
          Math.abs(distance) <= wall.thickness / 2 ||
          (occupiedSide && side !== occupiedSide)
        )
          return null;
        occupiedSide = side;
      }
    }
  }
  for (const person of building.placed_occupants ?? []) {
    const distance =
      (person.x - wall.start.x) * nx + (person.y - wall.start.y) * ny;
    const side = Math.sign(distance);
    if (
      Math.abs(distance) <= wall.thickness / 2 + building.agent_radius ||
      (occupiedSide && side !== occupiedSide)
    )
      return null;
    occupiedSide = side;
  }
  return occupiedSide ? (occupiedSide > 0 ? -1 : 1) : null;
}

/** New windows are ready for emergency use. Explicit per-window overrides stay
 * intact; switching escape on also supplies the required scenario assumptions. */
export function configureWindowEscape(
  building: BuildingScenario,
  pane: WindowOpening,
  patch: Partial<NonNullable<WindowOpening["emergency_escape"]>> = {},
): BuildingScenario {
  const wall = building.walls.find((wall) => wall.id === pane.wall_id);
  let exterior = suggestedWindowExterior(building, pane);
  if (exterior === null && wall) {
    // Before occupants are placed, point away from the rest of the plan.
    let x = 0,
      y = 0,
      weight = 0;
    for (const other of building.walls.filter(
      (other) => other.id !== wall.id,
    )) {
      const length = wallLength(other);
      x += ((other.start.x + other.end.x) / 2) * length;
      y += ((other.start.y + other.end.y) / 2) * length;
      weight += length;
    }
    const center = weight
      ? { x: x / weight, y: y / weight }
      : { x: building.width / 2, y: building.height / 2 };
    const side =
      (center.x - wall.start.x) * -(wall.end.y - wall.start.y) +
      (center.y - wall.start.y) * (wall.end.x - wall.start.x);
    exterior = side >= 0 ? -1 : 1;
  }
  const escape = {
    enabled: true,
    preparation: "break" as const,
    clear_width_metres: pane.width,
    clear_height_metres: Math.max(
      1.2,
      building.window_escape_context?.required_clear_height_metres ?? 1,
    ),
    preparation_seconds: 5,
    traversal_seconds: 3,
    exterior_side: exterior ?? -1,
    exterior_available: true,
    ...pane.emergency_escape,
    ...(patch.enabled === true ? { exterior_available: true } : {}),
    ...patch,
  };
  const ready = { ...pane, emergency_escape: escape };
  const existing =
    building.windows?.some((window) => window.id === pane.id) ?? false;
  return {
    ...building,
    windows: existing
      ? building.windows!.map((window) =>
          window.id === pane.id ? ready : window,
        )
      : [...(building.windows ?? []), ready],
    ...(escape.enabled &&
    (!building.window_escape_context || !existing || patch.enabled === true)
      ? {
          window_escape_context: {
            floor_elevation_metres: 0,
            required_clear_height_metres:
              building.window_escape_context?.required_clear_height_metres ?? 1,
            all_agents_can_traverse: true,
          },
        }
      : {}),
  };
}

/** Apply editor defaults to older imports and templates as well as new windows. */
export function withWindowEscapeDefaults(
  building: BuildingScenario,
): BuildingScenario {
  let ready = building;
  for (const pane of building.windows ?? []) {
    if (!pane.emergency_escape) ready = configureWindowEscape(ready, pane);
  }
  if (
    !ready.window_escape_context &&
    ready.windows?.some((pane) => pane.emergency_escape?.enabled)
  ) {
    ready = {
      ...ready,
      window_escape_context: {
        floor_elevation_metres: 0,
        all_agents_can_traverse: true,
        required_clear_height_metres: 1,
      },
    };
  }
  return ready;
}

/** Same interval sweep as Rust: touching gaps are continuous; blocked exits stay solid. */
export function solidWallSegments(
  building: OpeningLayout,
  wall: Wall,
  windowStates: readonly WindowFrameState[] = [],
): [Point, Point][] {
  const openings = [
    ...[...building.doors, ...building.exits].filter(
      (opening) =>
        !openingStartsBlocked(building, opening.id) &&
        !building.closedDoorIds?.includes(opening.id),
    ),
    ...(building.windows ?? [])
      .filter((w) =>
        windowStates.some(
          (s) =>
            s.window_id === w.id &&
            (s.state === "open" || s.state === "broken"),
        ),
      )
      .map((w) => ({
        ...w,
        offset:
          w.offset +
          (w.width - (w.emergency_escape?.clear_width_metres ?? w.width)) / 2,
        width: w.emergency_escape?.clear_width_metres ?? w.width,
      })),
  ]
    .filter((o) => o.wall_id === wall.id)
    .sort((a, b) => a.offset - b.offset);
  const length = wallLength(wall),
    at = (offset: number) => ({
      x: wall.start.x + ((wall.end.x - wall.start.x) * offset) / length,
      y: wall.start.y + ((wall.end.y - wall.start.y) * offset) / length,
    });
  let cursor = 0;
  const segments: [Point, Point][] = [];
  for (const o of openings) {
    const start = Math.max(0, Math.min(length, o.offset)),
      end = Math.max(0, Math.min(length, o.offset + o.width));
    if (start - cursor > OPENING_EPSILON)
      segments.push([at(cursor), at(start)]);
    cursor = Math.max(cursor, end);
  }
  if (length - cursor > OPENING_EPSILON)
    segments.push([at(cursor), at(length)]);
  return segments;
}
export interface OpeningLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  anchor: Point;
}
/** Place horizontal labels in nonoverlapping rows near their real opening, in world units. */
export function openingLabels(
  building: OpeningLayout,
  px: number,
  measure: (text: string) => number,
  windowStates: readonly WindowFrameState[] = [],
  options?: {
    measurements: MeasurementVisibility;
    showNames: boolean;
    declutter?: boolean;
    focusIds?: ReadonlySet<string>;
  },
): OpeningLabel[] {
  const placed: OpeningLabel[] = [];
  const candidates = (
    [
      ["doors", "Door", building.doors],
      ["exits", "Exit", building.exits],
      ["windows", "Window", building.windows ?? []],
    ] as const
  ).flatMap(([key, kind, items]) =>
    items.map((opening) => ({ key, kind, opening })),
  );
  const priority = (id: string, kind: string) =>
    options?.focusIds?.has(id)
      ? 3
      : openingStartsBlocked(building, id) ||
          building.closedDoorIds?.includes(id)
        ? 2
        : kind === "Exit"
          ? 1
          : 0;
  // Reserve label space for the selection and important states before ordinary openings.
  if (options?.declutter)
    candidates.sort(
      (a, b) => priority(b.opening.id, b.kind) - priority(a.opening.id, a.kind),
    );
  for (const { key, kind, opening: o } of candidates) {
    const showName = options?.showNames !== false;
    const showWidth = options?.measurements[key] !== false;
    if (!showName && !showWidth) continue;
    const focused = options?.focusIds?.has(o.id);
    if (options?.declutter && !priority(o.id, kind) && o.width / px < 44)
      continue;
    const wall = building.walls.find((w) => w.id === o.wall_id);
    if (!wall) continue;
    const [a, b] = openingSegment(o, wall),
      anchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const state =
      kind === "Window"
        ? windowStates.find((s) => s.window_id === o.id)?.state
        : undefined;
    const label = building.closedDoorIds?.includes(o.id)
      ? "Closed door"
      : openingStartsBlocked(building, o.id)
        ? `Blocked ${kind.toLowerCase()}`
        : kind;
    const text = [
      showName ? label : null,
      showWidth ? formatLength(o.width) : null,
      showName && state ? state : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const width = Math.min(measure(text), building.width),
      height = 13 * px;
    const x = Math.max(0, Math.min(building.width - width, anchor.x + 7 * px));
    let candidate: OpeningLabel | undefined;
    for (let row = 0; row < (options?.declutter && !focused ? 4 : 40); row++) {
      const dy = (Math.floor(row / 2) + 1) * 17 * px * (row % 2 ? 1 : -1);
      const y = Math.max(height, Math.min(building.height, anchor.y + dy));
      const next = { id: o.id, text, x, y, width, height, anchor };
      const clear = !placed.some(
        (p) =>
          x < p.x + p.width + 3 * px &&
          p.x < x + width + 3 * px &&
          y - height < p.y + 3 * px &&
          p.y - p.height < y + 3 * px,
      );
      if (clear || !options?.declutter || focused) candidate = next;
      if (clear) break;
    }
    if (candidate) placed.push(candidate);
  }
  return placed;
}

/** Pick the closest actual interval, so nearby/touching records remain individually selectable. */
export function hitOpening(
  building: BuildingScenario,
  point: Point,
  tolerance: number,
): { kind: "doors" | "exits" | "windows"; id: string } | null {
  const candidates = [];
  for (const kind of ["doors", "exits", "windows"] as const)
    for (const opening of building[kind] ?? []) {
      const wall = building.walls.find((w) => w.id === opening.wall_id);
      if (!wall) continue;
      const [start, end] = openingSegment(opening, wall),
        projected = project(point, { ...wall, start, end });
      if (projected.distance < tolerance)
        candidates.push({
          kind,
          id: opening.id,
          distance: projected.distance,
          center: distance(point, {
            x: (start.x + end.x) / 2,
            y: (start.y + end.y) / 2,
          }),
        });
    }
  candidates.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.center - b.center ||
      a.id.localeCompare(b.id),
  );
  const first = candidates[0];
  return first ? { kind: first.kind, id: first.id } : null;
}
