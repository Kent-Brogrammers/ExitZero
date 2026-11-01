import { buildingError } from "../editor/geometry";
import type { BuildingScenario } from "../types/simulation";
import { createTemplate, type UserTemplate } from "./templates";

export const DRAFT_STORAGE_KEY = "exitzero.studio.draft.v1";
export const DRAFT_DELAY_MS = 750;
export interface RecoveryDraft {
  version: 1;
  updatedAt: string;
  building: BuildingScenario;
  sourceLayout?: UserTemplate;
}
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function parseRecoveryDraft(raw: string): RecoveryDraft {
  const value = JSON.parse(raw);
  if (
    value?.version !== 1 ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    buildingError(value.building, false)
  )
    throw new Error(
      "The recovery copy could not be read. It has been kept unchanged.",
    );
  let sourceLayout: UserTemplate | undefined;
  if (value.sourceLayout !== undefined) {
    const source = value.sourceLayout;
    if (
      source?.kind !== "layout" ||
      typeof source.id !== "string" ||
      !source.id.trim() ||
      typeof source.name !== "string"
    )
      throw new Error(
        "The recovery copy's saved-layout reference is invalid. It has been kept unchanged.",
      );
    sourceLayout = createTemplate(
      source.building,
      source.name,
      source.id,
      "layout",
    );
  }
  return {
    version: 1,
    updatedAt: value.updatedAt,
    building: value.building,
    ...(sourceLayout ? { sourceLayout } : {}),
  };
}

/** Compare before writing/deleting so this tab cannot silently replace another tab's copy. */
export function checkRecoveryCopy(
  storage: Pick<Storage, "getItem">,
  expected: string | null,
) {
  if (storage.getItem(DRAFT_STORAGE_KEY) !== expected)
    throw new Error(
      "Another tab changed the recovery copy. Reload to review it; this drawing is unchanged.",
    );
}

export function saveRecoveryDraft(
  storage: DraftStorage,
  expected: string | null,
  building: BuildingScenario,
  sourceLayout: UserTemplate | null,
  updatedAt = new Date().toISOString(),
) {
  const raw = JSON.stringify({
    version: 1,
    updatedAt,
    building,
    ...(sourceLayout ? { sourceLayout } : {}),
  });
  const draft = parseRecoveryDraft(raw);
  checkRecoveryCopy(storage, expected);
  storage.setItem(DRAFT_STORAGE_KEY, raw);
  return { raw, draft };
}

export function discardRecoveryDraft(
  storage: DraftStorage,
  expected: string | null,
) {
  checkRecoveryCopy(storage, expected);
  storage.removeItem(DRAFT_STORAGE_KEY);
}
