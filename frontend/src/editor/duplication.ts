import type { BuildingScenario, Point } from "../types/simulation";
import { FOOT_METRES } from "../utils/units";
import {
  buildingError,
  clamp,
  rectanglesOverlap,
  wallIntersectsRectangle,
  wallLength,
  type Selection,
} from "./geometry";
import { MAX_OBJECT_NAME_LENGTH, objectName } from "./names";
import { roomFillGroup } from "./roomFill";
import {
  combineSelection,
  elementKinds,
  moveSelection,
  selectionBounds,
} from "./selection";

function copyName(building: BuildingScenario, item: Selection) {
  const prefix = objectName(building, item).replace(/ \(copy(?: \d+)?\)$/u, "");
  const used = new Set(
    (building[item.kind] ?? []).map((v) =>
      objectName(building, { kind: item.kind, id: v.id }),
    ),
  );
  for (let number = 1; ; number++) {
    const suffix = number === 1 ? " (copy)" : ` (copy ${number})`;
    const name =
      [...prefix]
        .slice(0, MAX_OBJECT_NAME_LENGTH - suffix.length)
        .join("")
        .trimEnd() + suffix;
    if (!used.has(name)) return name;
  }
}

/** Candidate translations along free intervals of an opening's original parent wall. */
function openingTranslations(
  building: BuildingScenario,
  items: readonly Selection[],
): Point[] {
  const walls = new Set(
    items.filter((item) => item.kind === "walls").map((item) => item.id),
  );
  const openings = [
    ...building.doors,
    ...building.exits,
    ...(building.windows ?? []),
  ];
  return items.flatMap((item) => {
    const opening = openings.find((v) => v.id === item.id);
    if (!opening || walls.has(opening.wall_id)) return [];
    const wall = building.walls.find((v) => v.id === opening.wall_id)!;
    const length = wallLength(wall);
    const occupied = openings
      .filter((v) => v.wall_id === wall.id)
      .sort((a, b) => a.offset - b.offset);
    const offsets: number[] = [];
    let low = 0;
    for (const other of occupied) {
      const high = other.offset - FOOT_METRES - opening.width;
      if (high >= low)
        offsets.push(clamp(opening.offset, low, high), low, high);
      low = Math.max(low, other.offset + other.width + FOOT_METRES);
    }
    const high = length - opening.width;
    if (high >= low) offsets.push(clamp(opening.offset, low, high), low, high);
    return [...new Set(offsets)]
      .sort(
        (a, b) => Math.abs(a - opening.offset) - Math.abs(b - opening.offset),
      )
      .slice(0, 8)
      .map((offset) => ({
        x: ((wall.end.x - wall.start.x) / length) * (offset - opening.offset),
        y: ((wall.end.y - wall.start.y) / length) * (offset - opening.offset),
      }));
  });
}

/** Atomic copies with fresh identities. Parent walls carry openings; room fills keep independent groups. */
export function duplicateSelection(
  building: BuildingScenario,
  selections: readonly Selection[],
  makeId: (kind: Selection["kind"]) => string = (kind) =>
    `${kind}_${crypto.randomUUID()}`,
) {
  const requested = combineSelection([], selections).filter((item) =>
    (building[item.kind] ?? []).some((v) => v.id === item.id),
  );
  const ids = new Map<string, string>();
  if (!requested.length) return { building, selections: [], ids };
  let items = [...requested];
  for (const item of requested) {
    if (item.kind === "walls") {
      for (const kind of ["doors", "exits", "windows"] as const)
        items = combineSelection(
          items,
          (building[kind] ?? [])
            .filter((v) => v.wall_id === item.id)
            .map((v) => ({ kind, id: v.id })),
        );
    }
    const group = item.kind === "spawn_zones" ? roomFillGroup(item.id) : null;
    if (group)
      items = combineSelection(
        items,
        building.spawn_zones
          .filter((v) => roomFillGroup(v.id) === group)
          .map((v) => ({ kind: "spawn_zones", id: v.id })),
      );
  }
  const usedIds = new Set(
    elementKinds.flatMap((kind) => (building[kind] ?? []).map((v) => v.id)),
  );
  const roomGroups = new Map<string, string>();
  for (const item of items) {
    const group = item.kind === "spawn_zones" ? roomFillGroup(item.id) : null;
    let id: string;
    if (group) {
      if (!roomGroups.has(group))
        roomGroups.set(
          group,
          makeId("spawn_zones")
            .replace(/[^a-zA-Z0-9-]/gu, "-")
            .slice(0, 48),
        );
      id = `roomfill_${roomGroups.get(group)}_${item.id.split("_").at(-1)}`;
    } else id = makeId(item.kind);
    if (usedIds.has(id))
      throw new Error(
        "Could not create unique copy IDs. Try duplicating again.",
      );
    usedIds.add(id);
    ids.set(item.id, id);
  }
  const appended = { ...building };
  for (const item of items) {
    const source = (building[item.kind] ?? []).find((v) => v.id === item.id)!;
    const copy = {
      ...structuredClone(source),
      id: ids.get(item.id)!,
      name: copyName(appended, item),
    };
    if ("wall_id" in copy) copy.wall_id = ids.get(copy.wall_id) ?? copy.wall_id;
    Object.assign(appended, {
      [item.kind]: [...(appended[item.kind] ?? []), copy],
    });
  }
  const blocked = building.blocked_exit_ids.flatMap((id) =>
    ids.has(id) ? [ids.get(id)!] : [],
  );
  if (blocked.length)
    appended.blocked_exit_ids = [...building.blocked_exit_ids, ...blocked];
  const events = (building.opening_events ?? []).flatMap((event) =>
    ids.has(event.opening_id)
      ? [{ ...event, opening_id: ids.get(event.opening_id)! }]
      : [],
  );
  if (events.length)
    appended.opening_events = [
      ...(building.opening_events ?? []),
      ...events,
    ].sort((a, b) => a.step - b.step);
  const copies = items.map((item) => ({ ...item, id: ids.get(item.id)! }));
  const selectedCopies = items
    .filter(
      (item) =>
        item.kind === "spawn_zones" || requested.some((v) => v.id === item.id),
    )
    .map((item) => ({ ...item, id: ids.get(item.id)! }));
  const bounds = selectionBounds(building, items)!;
  const dx = bounds.width + FOOT_METRES,
    dy = bounds.height + FOOT_METRES;
  const translations = [
    ...openingTranslations(building, items),
    { x: dx, y: 0 },
    { x: 0, y: dy },
    { x: -dx, y: 0 },
    { x: 0, y: -dy },
    { x: dx, y: dy },
    { x: -dx, y: dy },
    { x: dx, y: -dy },
    { x: -dx, y: -dy },
  ];
  let problem: string | null = null;
  for (const delta of translations) {
    const moved = moveSelection(appended, copies, delta);
    const candidate = { ...appended };
    for (const kind of elementKinds) {
      const count = building[kind]?.length ?? 0;
      const additions = (moved[kind] ?? []).slice(count);
      if (additions.length)
        Object.assign(candidate, {
          [kind]: [...(building[kind] ?? []), ...additions],
        });
    }
    problem = buildingError(candidate, false);
    if (problem) continue;
    const newObjects = candidate.obstructions.slice(
      building.obstructions.length,
    );
    const newWalls = candidate.walls.slice(building.walls.length);
    if (
      newObjects.some(
        (copy) =>
          building.obstructions.some((old) => rectanglesOverlap(copy, old)) ||
          building.walls.some((wall) => wallIntersectsRectangle(wall, copy)),
      )
    )
      continue;
    if (
      newWalls.some((copy) =>
        building.obstructions.some((old) => wallIntersectsRectangle(copy, old)),
      )
    )
      continue;
    return { building: candidate, selections: selectedCopies, ids };
  }
  throw new Error(
    `No valid nearby position for this selection. Make room or enlarge the Canvas; openings need space along their parent wall.${problem ? ` ${problem}` : ""}`,
  );
}
