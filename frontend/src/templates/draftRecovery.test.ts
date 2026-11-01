import { expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import { createTemplate, TEMPLATE_STORAGE_KEY } from "./templates";
import {
  DRAFT_STORAGE_KEY,
  parseRecoveryDraft,
  saveRecoveryDraft,
  discardRecoveryDraft,
} from "./draftRecovery";

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

it("round-trips an unfinished layout and its original saved-layout reference without touching the library", () => {
  const storage = memory();
  storage.setItem(TEMPLATE_STORAGE_KEY, "untouched library");
  const original = createTemplate(
    example,
    "Main office",
    "saved-office",
    "layout",
  );
  const edited = {
    ...example,
    seed: example.seed + 1,
    exits: [],
    blocked_exit_ids: [],
  };
  const saved = saveRecoveryDraft(
    storage,
    null,
    edited,
    original,
    "2026-11-01T12:00:00.000Z",
  );
  const restored = parseRecoveryDraft(saved.raw);
  expect(restored.building).toEqual(edited);
  expect(restored.sourceLayout).toEqual(original);
  restored.building.seed++;
  expect(
    parseRecoveryDraft(storage.getItem(DRAFT_STORAGE_KEY)!).building.seed,
  ).toBe(edited.seed);
  expect(original.building).toEqual(example);
  expect(storage.getItem(TEMPLATE_STORAGE_KEY)).toBe("untouched library");
});

it.each([
  "not JSON",
  JSON.stringify({
    version: 2,
    updatedAt: new Date().toISOString(),
    building: example,
  }),
  JSON.stringify({ version: 1, updatedAt: "bad date", building: example }),
  JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    building: { ...example, width: -1 },
  }),
])(
  "rejects unreadable or unsupported recovery data without deleting it (%s)",
  (raw) => {
    const storage = memory();
    storage.setItem(DRAFT_STORAGE_KEY, raw);
    expect(() => parseRecoveryDraft(raw)).toThrow();
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBe(raw);
  },
);

it("detects another tab's newer copy before writes or deletion", () => {
  const storage = memory();
  const old = saveRecoveryDraft(storage, null, example, null);
  const newer = saveRecoveryDraft(
    storage,
    old.raw,
    { ...example, seed: 99 },
    null,
  );
  expect(() => saveRecoveryDraft(storage, old.raw, example, null)).toThrow(
    /Another tab/,
  );
  expect(() => discardRecoveryDraft(storage, old.raw)).toThrow(/Another tab/);
  expect(storage.getItem(DRAFT_STORAGE_KEY)).toBe(newer.raw);
});

it("preserves the previous copy on quota failure and deletes only an explicitly matching copy", () => {
  const storage = memory();
  const saved = saveRecoveryDraft(storage, null, example, null);
  expect(() =>
    saveRecoveryDraft(
      {
        ...storage,
        setItem: () => {
          throw new Error("Storage full");
        },
      },
      saved.raw,
      { ...example, seed: 100 },
      null,
    ),
  ).toThrow("Storage full");
  expect(storage.getItem(DRAFT_STORAGE_KEY)).toBe(saved.raw);
  discardRecoveryDraft(storage, saved.raw);
  expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
});
