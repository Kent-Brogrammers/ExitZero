import { afterEach, describe, expect, it, vi } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";
import example from "../../../shared/examples/building.json";
import { buildingError } from "../editor/geometry";
import { setOpeningBlocked } from "../editor/openingState";
import { buildingPresets } from "../editor/presets";
import { TemplatesPage } from "./TemplatesPage";
import {
  createTemplate,
  readTemplates,
  writeTemplates,
  templateName,
  TEMPLATE_STORAGE_KEY,
} from "./templates";
import { StudioWelcome } from "../studio/StudioWelcome";
import { TemplateCard } from "./TemplateCard";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("local building templates", () => {
  it("saves independent JSON-compatible copies including initial closures, names and schedules", () => {
    const original = setOpeningBlocked(
      {
        ...example,
        opening_events: [
          { step: 20, opening_id: "door_north", blocked: false },
        ],
      },
      "doors",
      "door_north",
      true,
    );
    const before = JSON.stringify(original);
    const entry = createTemplate(original, "  Team office  ", "custom-one");
    expect(entry.name).toBe("Team office");
    expect(entry.building).toEqual(original);
    expect(entry.building).not.toBe(original);
    const storage = memoryStorage();
    expect(readTemplates(storage)).toEqual([]);
    writeTemplates(storage, [entry]);
    const restored = readTemplates(storage);
    expect(restored).toEqual([entry]);
    expect(buildingError(restored[0]!.building)).toBeNull();
    restored[0]!.building.doors[0]!.width = 0.5;
    expect(readTemplates(storage)).toEqual([entry]);
    expect(JSON.stringify(original)).toBe(before);
  });

  it("stores rename/delete operations without modifying building geometry or the current layout", () => {
    const storage = memoryStorage();
    const first = createTemplate(example, "First", "a");
    const second = createTemplate(example, "Second", "b");
    writeTemplates(storage, [first, second]);
    writeTemplates(storage, [
      { ...first, name: templateName(" North wing ") },
      second,
    ]);
    expect(readTemplates(storage).map((entry) => entry.name)).toEqual([
      "North wing",
      "Second",
    ]);
    expect(readTemplates(storage)[0]!.building).toEqual(example);
    writeTemplates(storage, [second]);
    expect(readTemplates(storage)).toEqual([second]);
    expect(first.name).toBe("First");
  });

  it.each(["", "   ", "x".repeat(81)])("rejects invalid names (%s)", (name) => {
    expect(() => createTemplate(example, name, "id")).toThrow(/1 and 80/);
  });

  it("allows valid draft layouts but rejects malformed geometry", () => {
    expect(
      createTemplate(
        { ...example, exits: [], blocked_exit_ids: [] },
        "Draft",
        "draft",
      ).name,
    ).toBe("Draft");
    expect(() =>
      createTemplate({ ...example, width: -1 }, "Invalid", "bad"),
    ).toThrow(/Cannot save/);
  });

  it("preserves all built-in presets when an edited template copy changes", () => {
    const original = JSON.stringify(buildingPresets);
    for (const preset of buildingPresets) {
      const copy = createTemplate(preset.building, preset.label, preset.id);
      copy.building.walls[0]!.thickness = 0.5;
    }
    expect(JSON.stringify(buildingPresets)).toBe(original);
  });

  it("rejects corrupt/unsupported stored data and duplicate IDs without overwriting it", () => {
    const good = createTemplate(example, "Valid", "a");
    for (const raw of [
      "{",
      "null",
      JSON.stringify({ version: 2, templates: [] }),
      JSON.stringify({ version: 1, templates: [good, good] }),
      JSON.stringify({ version: 1, templates: [{ ...good, name: " " }] }),
      JSON.stringify({
        version: 1,
        templates: [{ ...good, building: { width: 0 } }],
      }),
    ]) {
      const storage = memoryStorage();
      storage.setItem(TEMPLATE_STORAGE_KEY, raw);
      expect(() => readTemplates(storage)).toThrow();
      expect(storage.getItem(TEMPLATE_STORAGE_KEY)).toBe(raw);
    }
  });

  it("surfaces storage failure without changing the existing data or saved copy", () => {
    const storage = memoryStorage();
    const entry = createTemplate(example, "Saved", "a");
    writeTemplates(storage, [entry]);
    const before = storage.getItem(TEMPLATE_STORAGE_KEY);
    const full = {
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(() => writeTemplates(full, [])).toThrow("QuotaExceeded");
    expect(storage.getItem(TEMPLATE_STORAGE_KEY)).toBe(before);
  });
});

describe("Templates presentation", () => {
  const props = {
    building: example,
    busy: false,
    online: true,
    onOpen: () => {},
    onSaved: () => {},
    onOfficeRecording: () => {},
  };
  it("lists actual preset previews, dimensions, populations and explicit office recording access", () => {
    const html = renderToStaticMarkup(<TemplatesPage {...props} />);
    expect(html.match(/role="img"/g)).toHaveLength(4);
    for (const preset of buildingPresets) {
      expect(html).toContain(`${preset.label} floor plan preview`);
      expect(html).toContain(
        `${preset.building.width} × ${preset.building.height} m`,
      );
      expect(html).toContain(
        `${preset.building.spawn_zones.reduce((n, z) => n + z.count, 0)} occupants`,
      );
    }
    expect(html.match(/>Run Simulation<\/button>/g)).toHaveLength(4);
    expect(html).toContain("View saved office recording");
    expect(html).toContain("My Templates");
    expect(html).toContain("Save Current Layout");
  });
  it("renders local templates and disables simulation while offline without disabling Edit", () => {
    const storage = memoryStorage();
    writeTemplates(storage, [createTemplate(example, "Custom office", "a")]);
    vi.stubGlobal("window", { localStorage: storage });
    const html = renderToStaticMarkup(
      <TemplatesPage {...props} online={false} />,
    );
    expect(html).toContain("Custom office floor plan preview");
    expect(html).toContain("Rename");
    expect(html).toContain("Delete");
    expect(html).toContain("Backend offline");
    expect(html.match(/>Edit<\/button>/g)).toHaveLength(5);
  });
  it("reports unreadable storage and disables saving to avoid destroying it", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "corrupt" } });
    const html = renderToStaticMarkup(<TemplatesPage {...props} />);
    expect(html).toContain("Existing browser storage has not been overwritten");
    expect(html).toMatch(/class="template-save-card" disabled=""/);
  });
  it("links to Templates from the existing welcome experience", () => {
    const html = renderToStaticMarkup(
      <StudioWelcome
        building={example}
        onOpen={() => {}}
        onLoadExample={() => {}}
        onTemplates={() => {}}
      />,
    );
    expect(html).toContain("Browse templates");
    expect(html).toContain("Open Studio");
    expect(html).toContain("Load example building");
  });
  it("shares native, independently actionable Edit and Run buttons across gallery cards", () => {
    const html = renderToStaticMarkup(
      <TemplateCard
        name="My office"
        building={example}
        busy={false}
        online={true}
        onEdit={() => {}}
        onRun={() => {}}
      >
        <button type="button">Rename</button>
      </TemplateCard>,
    );
    expect(html).toContain('class="studio-control template-card-edit"');
    expect(html).toContain('title="Open My office in the editor"');
    expect(html.match(/<button /g)).toHaveLength(3);
    expect(html.match(/<\/button>/g)).toHaveLength(3);
    expect(html).not.toContain('role="button"');
    expect(html).toContain("Rename");
  });
  it("offers an in-page welcome gallery with a focusable scroll target and a separate full-library action", () => {
    const html = renderToStaticMarkup(
      <StudioWelcome
        building={example}
        onOpen={() => {}}
        onLoadExample={() => {}}
        onTemplates={() => {}}
        onOpenTemplate={() => {}}
        online={true}
      />,
    );
    expect(html).toContain('aria-controls="welcome-templates"');
    expect(html).toContain('id="welcome-templates-heading" tabindex="-1"');
    expect(html).toContain("Building templates");
    expect(html).toContain("Open Templates");
    expect(html.match(/class="template-card"/g)).toHaveLength(4);
    expect(html).toContain('class="entry-action"');
    expect(html).toContain('class="welcome-action-secondary"');
    expect(html).toContain('class="welcome-action-tertiary"');
  });
});
