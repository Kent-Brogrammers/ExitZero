import type { BuildingScenario } from "../types/simulation";
import { buildingError, type Selection } from "./geometry";
import { elementBounds, selectionBounds } from "./selection";
import { isSpawnZone, transformSpawn } from "./spawnGeometry";

export const arrangeActions = [
  { id: "left", label: "Align left", short: "Left" },
  { id: "center-x", label: "Align horizontal centers", short: "Center" },
  { id: "right", label: "Align right", short: "Right" },
  { id: "top", label: "Align top", short: "Top" },
  { id: "center-y", label: "Align vertical centers", short: "Middle" },
  { id: "bottom", label: "Align bottom", short: "Bottom" },
  { id: "gap-x", label: "Distribute horizontal gaps", short: "Horizontal" },
  { id: "gap-y", label: "Distribute vertical gaps", short: "Vertical" },
] as const;
export type ArrangeAction = (typeof arrangeActions)[number]["id"];
const eligible = new Set<Selection["kind"]>([
  "obstructions",
  "spawn_zones",
  "stair_areas",
  "tornado_zones",
]);
const EPS = 1e-8;

export function arrangeProblem(
  building: BuildingScenario,
  items: readonly Selection[],
) {
  if (items.length < 2)
    return "Select at least two objects or zones to arrange.";
  if (items.some((item) => !eligible.has(item.kind)))
    return "Arrange supports objects, spawn zones, stairs, and shelters. Deselect walls, openings, and individual occupants.";
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.some((item) => !elementBounds(building, item))
  )
    return "The selection changed. Select the objects again.";
  return null;
}

/** Translate whole footprints in metres; never resize or detach architectural geometry. */
export function arrangeSelection(
  building: BuildingScenario,
  items: readonly Selection[],
  action: ArrangeAction,
): {
  building: BuildingScenario;
  changed: boolean;
  error: string | null;
  gap?: number;
} {
  const problem = arrangeProblem(building, items);
  if (problem) return { building, changed: false, error: problem };
  const horizontal = ["left", "center-x", "right", "gap-x"].includes(action);
  const axis = horizontal ? "x" : "y",
    size = horizontal ? "width" : "height";
  const boxes = items.map((item) => ({
    item,
    bounds: elementBounds(building, item)!,
  }));
  const deltas = new Map<string, number>();
  let gap: number | undefined;
  if (action === "gap-x" || action === "gap-y") {
    if (items.length < 3)
      return {
        building,
        changed: false,
        error: "Select at least three objects or zones for equal gaps.",
      };
    boxes.sort(
      (a, b) =>
        a.bounds[axis] - b.bounds[axis] || a.item.id.localeCompare(b.item.id),
    );
    const first = boxes[0]!.bounds,
      last = boxes.at(-1)!.bounds;
    gap =
      (last[axis] +
        last[size] -
        first[axis] -
        boxes.reduce((sum, box) => sum + box.bounds[size], 0)) /
      (boxes.length - 1);
    if (gap < -EPS)
      return {
        building,
        changed: false,
        error:
          "Not enough space between the end objects for equal gaps. Move them farther apart first.",
      };
    gap = Math.max(0, gap);
    let position = first[axis] + first[size] + gap;
    for (const box of boxes.slice(1, -1)) {
      deltas.set(box.item.id, position - box.bounds[axis]);
      position += box.bounds[size] + gap;
    }
  } else {
    const bounds = selectionBounds(building, items)!;
    for (const box of boxes) {
      const position =
        action === "left" || action === "top"
          ? bounds[axis]
          : action === "right" || action === "bottom"
            ? bounds[axis] + bounds[size] - box.bounds[size]
            : bounds[axis] + (bounds[size] - box.bounds[size]) / 2;
      deltas.set(box.item.id, position - box.bounds[axis]);
    }
  }
  if (![...deltas.values()].some((delta) => Math.abs(delta) > EPS))
    return { building, changed: false, error: null, gap };
  const next = structuredClone(building);
  for (const { item } of boxes) {
    const delta = deltas.get(item.id) ?? 0;
    if (Math.abs(delta) <= EPS) continue;
    const object = (next[item.kind] ?? []).find(
      (element) => element.id === item.id,
    )!;
    if (!("x" in object)) continue;
    if (isSpawnZone(object)) {
      Object.assign(
        object,
        transformSpawn(object, (point) => ({
          x: point.x + (horizontal ? delta : 0),
          y: point.y + (horizontal ? 0 : delta),
        })),
      );
    } else object[axis] += delta;
  }
  return {
    building: next,
    changed: true,
    error: buildingError(next, false),
    gap,
  };
}
