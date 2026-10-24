import type { BuildingScenario } from "../types/simulation";
import type { Selection } from "./geometry";

export const MAX_OBJECT_NAME_LENGTH = 80;
const prefixes: Record<Selection["kind"], string> = {
  walls: "Wall",
  doors: "Door",
  exits: "Exit",
  spawn_zones: "Spawn zone",
  obstructions: "Obstruction",
};

export function objectName(
  building: BuildingScenario,
  selection: Selection,
): string {
  const index = building[selection.kind].findIndex(
    (item) => item.id === selection.id,
  );
  const element = building[selection.kind][index];
  return element?.name ?? `${prefixes[selection.kind]} ${index + 1}`;
}

export function nextObjectName(
  building: BuildingScenario,
  kind: Selection["kind"],
  prefix = prefixes[kind],
): string {
  const used = new Set(
    building[kind].map((item) => objectName(building, { kind, id: item.id })),
  );
  let number = 1;
  while (used.has(`${prefix} ${number}`)) number++;
  return `${prefix} ${number}`;
}

/** Trim the shared Unicode whitespace set, including NEL and the byte-order mark. */
export function normalizeObjectName(value: string): string {
  return value.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, "");
}

export function nameProblem(value: string): string | null {
  const name = normalizeObjectName(value);
  if (!name) return "Enter a name; whitespace alone is not a name.";
  if ([...name].length > MAX_OBJECT_NAME_LENGTH)
    return `Use ${MAX_OBJECT_NAME_LENGTH} characters or fewer.`;
  return null;
}

export function renameObject(
  building: BuildingScenario,
  selection: Selection,
  value: string,
): BuildingScenario {
  const problem = nameProblem(value);
  if (problem) throw new Error(problem);
  const next = structuredClone(building);
  const element = next[selection.kind].find((item) => item.id === selection.id);
  if (element) element.name = normalizeObjectName(value);
  return next;
}

/** Names are presentation metadata. Use this only to compare simulation inputs. */
export function withoutObjectNames(
  building: BuildingScenario,
): BuildingScenario {
  const next = structuredClone(building);
  for (const kind of Object.keys(prefixes) as Selection["kind"][])
    for (const element of next[kind]) delete element.name;
  return next;
}
