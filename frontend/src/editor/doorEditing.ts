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
export function mergeEditedDoors(
  before: BuildingScenario,
  candidate: BuildingScenario,
  preferredId?: string,
) {
  const old = new Map(before.doors.map((d) => [d.id, d]));
  const changed = new Set(
    candidate.doors
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
  if (
    !changed.size ||
    candidate.doors.some((d) => changed.has(d.id) && !fits(candidate, d))
  )
    return { building: candidate, replacements };
  const walls = new Map<string, Opening[]>();
  for (const door of candidate.doors) {
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
        const survivor =
          group.find((d) => d.id === preferredId && old.has(d.id)) ??
          group.find((d) => old.has(d.id)) ??
          group[0]!;
        const removed = group.filter((d) => d.id !== survivor.id);
        // Preserve stable IDs referenced by a scheduled opening change.
        if (
          !removed.some(
            (d) =>
              candidate.blocked_exit_ids.includes(d.id) ||
              candidate.opening_events?.some(
                (event) => event.opening_id === d.id,
              ),
          )
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
  if (!replacements.size) return { building: candidate, replacements };
  return {
    building: {
      ...candidate,
      doors: candidate.doors
        .filter((d) => !replacements.has(d.id))
        .map((d) => merged.get(d.id) ?? d),
    },
    replacements,
  };
}

/** Translate one door to a neighbour's edge, with no width change and no exit merging. */
export function snapDoorToNeighbor(
  building: BuildingScenario,
  id: string,
  tolerance: number,
) {
  const door = building.doors.find((d) => d.id === id);
  if (!door || !Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 0.2)
    return { building, snapped: false };
  const candidates = building.doors
    .filter((d) => d.id !== id && d.wall_id === door.wall_id)
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
    return {
      building: {
        ...building,
        doors: building.doors.map((d) => (d.id === id ? snapped : d)),
      },
      snapped: true,
    };
  }
  return { building, snapped: false };
}
