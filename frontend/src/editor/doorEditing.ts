import type { BuildingScenario, Opening } from "../types/simulation";
import { wallLength } from "./geometry";

const EPSILON = 1e-8; // Same metre tolerance as Rust opening validation.
const end = (door: Opening) => door.offset + door.width;

function fits(building: BuildingScenario, door: Opening): boolean {
  const wall = building.walls.find((w) => w.id === door.wall_id);
  return (
    !!wall &&
    Number.isFinite(door.offset) &&
    Number.isFinite(door.width) &&
    door.offset >= 0 &&
    door.width > 0 &&
    end(door) <= wallLength(wall) + EPSILON &&
    [...building.doors, ...building.exits].every(
      (other) =>
        other.id === door.id ||
        other.wall_id !== door.wall_id ||
        door.offset >= end(other) - EPSILON ||
        other.offset >= end(door) - EPSILON,
    )
  );
}

/** Only edited contact components are normalized; loading/renaming never rewrites IDs. */
function mergeKind(
  before: BuildingScenario,
  candidate: BuildingScenario,
  kind: "doors" | "exits",
  preferredId?: string,
) {
  const old = new Map(before[kind].map((d) => [d.id, d]));
  const changed = new Set(
    candidate[kind]
      .filter((d) => {
        const previous = old.get(d.id);
        return (
          !previous ||
          previous.offset !== d.offset ||
          previous.width !== d.width ||
          previous.wall_id !== d.wall_id
        );
      })
      .map((d) => d.id),
  );
  const replacements = new Map<string, string>();
  let error: string | null = null;
  if (
    !changed.size ||
    candidate[kind].some((d) => changed.has(d.id) && !fits(candidate, d))
  )
    return { building: candidate, replacements, error };
  const walls = new Map<string, Opening[]>();
  for (const door of candidate[kind]) {
    const list = walls.get(door.wall_id) ?? [];
    list.push(door);
    walls.set(door.wall_id, list);
  }
  const merged = new Map<string, Opening>();
  for (const doors of walls.values()) {
    doors.sort((a, b) => a.offset - b.offset || a.id.localeCompare(b.id));
    let group: Opening[] = [];
    const flush = () => {
      if (group.length > 1 && group.some((d) => changed.has(d.id))) {
        if (
          kind === "exits" &&
          new Set(group.map((d) => candidate.blocked_exit_ids.includes(d.id)))
            .size > 1
        ) {
          error =
            "Touching exits have different blocked states. Separate them or set matching blocked states before merging.";
          group = [];
          return;
        }
        const survivor =
          group.find((d) => d.id === preferredId && old.has(d.id)) ??
          group.find((d) => old.has(d.id)) ??
          group[0]!;
        const removed = group.filter((d) => d.id !== survivor.id);
        // The current contract only references exit IDs. Never erase a referenced ID in malformed input.
        if (
          kind === "exits" ||
          !removed.some((d) => candidate.blocked_exit_ids.includes(d.id))
        ) {
          merged.set(survivor.id, {
            ...survivor,
            offset: group[0]!.offset,
            width: end(group.at(-1)!) - group[0]!.offset,
          });
          for (const d of removed) replacements.set(d.id, survivor.id);
        }
      }
      group = [];
    };
    for (const door of doors) {
      if (group.length && Math.abs(door.offset - end(group.at(-1)!)) > EPSILON)
        flush();
      group.push(door);
    }
    flush();
  }
  if (error)
    return {
      building: candidate,
      replacements: new Map<string, string>(),
      error,
    };
  if (!replacements.size) return { building: candidate, replacements, error };
  return {
    building: {
      ...candidate,
      [kind]: candidate[kind]
        .filter((d) => !replacements.has(d.id))
        .map((d) => merged.get(d.id) ?? d),
      blocked_exit_ids:
        kind === "exits"
          ? [
              ...new Set(
                candidate.blocked_exit_ids.map(
                  (id) => replacements.get(id) ?? id,
                ),
              ),
            ]
          : candidate.blocked_exit_ids,
    },
    replacements,
    error,
  };
}

export function mergeEditedDoors(
  before: BuildingScenario,
  candidate: BuildingScenario,
  preferredId?: string,
) {
  return mergeKind(before, candidate, "doors", preferredId);
}

/** One atomic edit; mixed blocked-state exit contacts reject the whole transaction. */
export function mergeEditedOpenings(
  before: BuildingScenario,
  candidate: BuildingScenario,
  preferredId?: string,
) {
  const doors = mergeKind(before, candidate, "doors", preferredId);
  const exits = mergeKind(before, doors.building, "exits", preferredId);
  if (exits.error) return { ...exits, building: candidate };
  return {
    building: exits.building,
    replacements: new Map([...doors.replacements, ...exits.replacements]),
    error: null,
  };
}

/** Translate one opening to a compatible same-kind neighbour, without changing its width. */
export function snapOpeningToNeighbor(
  building: BuildingScenario,
  kind: "doors" | "exits",
  id: string,
  tolerance: number,
) {
  const door = building[kind].find((d) => d.id === id);
  if (!door || !Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 0.2)
    return { building, snapped: false };
  const candidates = building[kind]
    .filter(
      (d) =>
        d.id !== id &&
        d.wall_id === door.wall_id &&
        (kind === "doors" ||
          building.blocked_exit_ids.includes(d.id) ===
            building.blocked_exit_ids.includes(id)),
    )
    .flatMap((other) => [
      { offset: end(other), target: other.id },
      { offset: other.offset - door.width, target: other.id },
    ])
    .filter((c) => Math.abs(c.offset - door.offset) <= tolerance + EPSILON)
    .sort(
      (a, b) =>
        Math.abs(a.offset - door.offset) - Math.abs(b.offset - door.offset) ||
        a.target.localeCompare(b.target),
    );
  for (const c of candidates) {
    const snapped = { ...door, offset: Math.max(0, c.offset) };
    if (c.offset < -EPSILON || !fits(building, snapped)) continue;
    const next = {
      ...building,
      [kind]: building[kind].map((d) => (d.id === id ? snapped : d)),
    };
    // A bridge may touch a third exit with incompatible state; don't offer that snap.
    if (kind === "exits" && mergeKind(building, next, kind, id).error) continue;
    return { building: next, snapped: true };
  }
  return { building, snapped: false };
}

export function snapDoorToNeighbor(
  building: BuildingScenario,
  id: string,
  tolerance: number,
) {
  return snapOpeningToNeighbor(building, "doors", id, tolerance);
}
