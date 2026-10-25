import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import {
  createTemplate,
  readTemplates,
  writeTemplates,
  TEMPLATE_STORAGE_KEY,
} from "./templates";
import { storeLayout } from "./layouts";
import { LayoutNameDialog } from "./LayoutNameDialog";

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};

describe("named local layout saving", () => {
  it("preserves legacy templates while creating and updating one stable saved-layout ID", () => {
    const storage = memory();
    const legacy = createTemplate(example, "Reusable", "old-template");
    writeTemplates(storage, [legacy]);
    const first = storeLayout(storage, example, "  Headquarters  ", "layout");
    expect(first.kind).toBe("layout");
    expect(first.name).toBe("Headquarters");
    const edited: BuildingScenario = structuredClone(example);
    edited.walls[0]!.name = "Main facade";
    const next = storeLayout(storage, edited, first.name, "layout", first);
    expect(next.id).toBe(first.id);
    expect(readTemplates(storage)).toEqual([legacy, next]);
    expect(first.building).toEqual(example);
    expect(next.building).toEqual(edited);
  });

  it("Save As, duplication and Save as Template create independent copies", () => {
    const storage = memory();
    const original = storeLayout(storage, example, "Original", "layout");
    const copy = storeLayout(
      storage,
      original.building,
      "Original copy",
      "layout",
    );
    const template = storeLayout(
      storage,
      copy.building,
      "Reusable office",
      "template",
    );
    expect(new Set([original.id, copy.id, template.id]).size).toBe(3);
    expect(template.kind).toBeUndefined();
    copy.building.walls[0]!.name = "Only in memory";
    expect(readTemplates(storage)[1]!.building).toEqual(example);
    expect(readTemplates(storage)[0]!.building).toEqual(example);
  });

  it("rejects same-name overwrites and stale/deleted targets without changing storage", () => {
    const storage = memory();
    const original = storeLayout(storage, example, "Office", "layout");
    const snapshot = storage.getItem(TEMPLATE_STORAGE_KEY);
    expect(() => storeLayout(storage, example, " office ", "layout")).toThrow(
      /already in use/,
    );
    expect(storage.getItem(TEMPLATE_STORAGE_KEY)).toBe(snapshot);
    storeLayout(storage, example, "Renamed", "layout", original);
    const renamed = storage.getItem(TEMPLATE_STORAGE_KEY);
    expect(() =>
      storeLayout(storage, example, "Office", "layout", original),
    ).toThrow(/changed or was deleted/);
    expect(storage.getItem(TEMPLATE_STORAGE_KEY)).toBe(renamed);
    writeTemplates(storage, []);
    expect(() =>
      storeLayout(storage, example, "Office", "layout", original),
    ).toThrow(/changed or was deleted/);
    expect(readTemplates(storage)).toEqual([]);
  });

  it("preserves corrupt storage, unsupported metadata and rejected writes", () => {
    const storage = memory();
    storage.setItem(TEMPLATE_STORAGE_KEY, "corrupt");
    expect(() => storeLayout(storage, example, "Office", "layout")).toThrow();
    expect(storage.getItem(TEMPLATE_STORAGE_KEY)).toBe("corrupt");
    const unsupported = {
      ...createTemplate(example, "Future", "a"),
      kind: "unknown",
    };
    storage.setItem(
      TEMPLATE_STORAGE_KEY,
      JSON.stringify({ version: 1, templates: [unsupported] }),
    );
    expect(() => readTemplates(storage)).toThrow();
    const existing = createTemplate(example, "Existing", "safe");
    writeTemplates(storage, [existing]);
    expect(() =>
      storeLayout(
        {
          getItem: storage.getItem,
          setItem: () => {
            throw new Error("Storage full");
          },
        },
        example,
        "Office",
        "layout",
      ),
    ).toThrow("Storage full");
    expect(readTemplates(storage)).toEqual([existing]);
  });

  it("uses a compact named modal with cancel, accessible validation and no backend persistence", () => {
    const html = renderToStaticMarkup(
      <LayoutNameDialog
        title="Save layout as"
        initialName="Office copy"
        action="Save"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("<dialog");
    expect(html).toContain("Layout name");
    expect(html).toContain('maxLength="80"');
    expect(html).toContain("Cancel");
    expect(html).toContain("Stored only in this browser");
  });
});
