import type { BuildingScenario } from "../types/simulation";
import {
  createTemplate,
  readTemplates,
  writeTemplates,
  type UserTemplate,
} from "./templates";

export interface LayoutSaveActions {
  save: () => void;
  saveAs: () => void;
  saveTemplate: () => void;
  open: () => void;
}

/** Read before every write: preserve legacy templates and never replace corrupt data. */
export function storeLayout(
  storage: Pick<Storage, "getItem" | "setItem">,
  building: BuildingScenario,
  name: string,
  kind: "layout" | "template",
  current?: UserTemplate,
) {
  const entries = readTemplates(storage);
  if (current) {
    const saved = entries.find((entry) => entry.id === current.id);
    if (!saved || JSON.stringify(saved) !== JSON.stringify(current))
      throw new Error(
        "This saved layout changed or was deleted. Reopen it, or use Save As to keep your changes.",
      );
  }
  const next = createTemplate(building, name, current?.id, kind);
  if (
    entries.some(
      (entry) =>
        entry.id !== next.id &&
        (entry.kind === "layout" ? "layout" : "template") === kind &&
        entry.name.toLocaleLowerCase() === next.name.toLocaleLowerCase(),
    )
  )
    throw new Error(
      "That name is already in use. Choose another name or open the saved layout to update it.",
    );
  writeTemplates(
    storage,
    current
      ? entries.map((entry) => (entry.id === next.id ? next : entry))
      : [...entries, next],
  );
  return next;
}
