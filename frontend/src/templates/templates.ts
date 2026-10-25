import type { BuildingScenario } from "../types/simulation";
import { buildingError } from "../editor/geometry";

export const TEMPLATE_STORAGE_KEY = "exitzero.studio.templates.v1";
export interface UserTemplate {
  id: string;
  name: string;
  building: BuildingScenario;
}

export function templateName(value: string) {
  const name = value.trim();
  if (!name || name.length > 80)
    throw new Error("Use a template name between 1 and 80 characters.");
  return name;
}

export function createTemplate(
  building: BuildingScenario,
  name: string,
  id: string = crypto.randomUUID(),
): UserTemplate {
  const problem = buildingError(building, false);
  if (problem) throw new Error(`Cannot save this layout: ${problem}`);
  return { id, name: templateName(name), building: structuredClone(building) };
}

export function readTemplates(
  storage: Pick<Storage, "getItem">,
): UserTemplate[] {
  const raw = storage.getItem(TEMPLATE_STORAGE_KEY);
  if (raw === null) return [];
  const saved = JSON.parse(raw);
  if (saved?.version !== 1 || !Array.isArray(saved.templates))
    throw new Error("Unrecognized template storage format.");
  const ids = new Set<string>();
  return saved.templates.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !entry.id.trim() ||
      ids.has(entry.id) ||
      !("name" in entry) ||
      typeof entry.name !== "string" ||
      !("building" in entry) ||
      buildingError(entry.building, false)
    )
      throw new Error(
        "A saved template is invalid. Existing storage has been preserved.",
      );
    ids.add(entry.id);
    return createTemplate(
      entry.building as BuildingScenario,
      entry.name,
      entry.id,
    );
  });
}

/** Only called after an explicit save/rename/delete. Storage failures propagate. */
export function writeTemplates(
  storage: Pick<Storage, "setItem">,
  templates: UserTemplate[],
) {
  storage.setItem(
    TEMPLATE_STORAGE_KEY,
    JSON.stringify({ version: 1, templates }),
  );
}
