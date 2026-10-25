import Ajv from "ajv";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import recording from "./office-demo/recording.json";
import contracts from "../../../shared/schemas/contracts.schema.json";
import { buildingError } from "../editor/geometry";
import { buildingPresets } from "../editor/presets";
import { officeDemoBuilding, loadOfficeDemo } from "./officeDemo";
import { OfficeDemoNotice } from "./OfficeDemoNotice";
import { StudioWelcome } from "./StudioWelcome";
import { SimulationView } from "../simulation/SimulationView";
const ajv = new Ajv({ allErrors: true });
ajv.addSchema(contracts);

describe("curated office demo", () => {
  beforeEach(() =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(recording)),
    ),
  );
  afterEach(() => vi.unstubAllGlobals());
  it("adds an editable office without removing the existing presets or inventing fields", () => {
    expect(buildingPresets.map((p) => p.id)).toEqual([
      "house",
      "classroom",
      "office",
      "office-demo",
      "school-emergency",
      "corporate-office",
    ]);
    expect(buildingError(officeDemoBuilding)).toBeNull();
    expect(officeDemoBuilding.spawn_zones).toHaveLength(6);
    expect(officeDemoBuilding.exits).toHaveLength(2);
    expect(officeDemoBuilding.obstructions.length).toBeGreaterThan(10);
    expect(officeDemoBuilding.spawn_zones.map((z) => z.name)).toContain(
      "Meeting room",
    );
    expect(JSON.parse(JSON.stringify(officeDemoBuilding))).toEqual(
      officeDemoBuilding,
    );
    expect("frames" in officeDemoBuilding).toBe(false);
  });
  it("validates the saved Rust result and its exact matching building against shared schemas", async () => {
    const recording = await loadOfficeDemo();
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toMatch(
      /office-demo\/recording\.json$/,
    );
    for (const [type, value] of [
      ["BuildingScenario", officeDemoBuilding],
      ["SimulationResult", recording],
    ] as const) {
      const validate = ajv.getSchema(`${contracts.$id}#/$defs/${type}`)!;
      expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
    }
    expect(recording.width).toBe(officeDemoBuilding.width);
    expect(recording.height).toBe(officeDemoBuilding.height);
    expect(recording.time_step_seconds).toBe(
      officeDemoBuilding.time_step_seconds,
    );
    expect(recording.total_population).toBe(
      officeDemoBuilding.spawn_zones.reduce((sum, z) => sum + z.count, 0),
    );
    expect(recording.evacuated + recording.remaining).toBe(
      recording.total_population,
    );
    expect(recording.status).toBe("completed");
    expect(recording.evacuated).toBe(56);
    expect(recording.analytics?.simulated_seconds).toBe(29.8);
    expect(recording.traffic_samples.length).toBeGreaterThan(100);
    const exits = new Set(officeDemoBuilding.exits.map((e) => e.id));
    expect(
      recording.analytics?.agents.every(
        (a) => a.route_found && a.exit_id && exits.has(a.exit_id),
      ),
    ).toBe(true);
    expect(recording.frames[0]!.agents).toHaveLength(56);
    expect(recording.frames.at(-1)!.agents).toHaveLength(0);
    expect(recording.frames.at(-1)!.step).toBe(recording.clearance_steps);
  });
  it("returns independent recording copies without mutating the saved data", async () => {
    const first = await loadOfficeDemo(),
      second = await loadOfficeDemo();
    first.frames[0]!.agents[0]!.x = 999;
    expect(second.frames[0]!.agents[0]!.x).not.toBe(999);
    expect((await loadOfficeDemo()).frames[0]!.agents).toEqual(
      second.frames[0]!.agents,
    );
  });
  it("labels saved versus edited data honestly and exposes a return action", async () => {
    const recording = await loadOfficeDemo();
    const html = renderToStaticMarkup(
      <OfficeDemoNotice
        source="recorded"
        result={recording}
        busy={false}
        onEdit={() => {}}
        onReturn={() => {}}
      />,
    );
    expect(html).toContain("Precomputed Rust recording");
    expect(html).toContain("56 / 56 evacuated");
    expect(html).toContain("29.8");
    expect(html).toContain("Return to your layout");
    const edited = renderToStaticMarkup(
      <OfficeDemoNotice
        source="edited"
        result={null}
        busy={false}
        onEdit={() => {}}
        onReturn={() => {}}
      />,
    );
    expect(edited).toContain("run a simulation for new results");
    expect(edited).not.toContain("56 / 56");
    expect(edited).not.toContain("office-demo-scale");
  });
  it("offers the demo from the existing welcome composition", () => {
    const html = renderToStaticMarkup(
      <StudioWelcome
        building={officeDemoBuilding}
        onOpen={() => {}}
        onLoadExample={() => {}}
        onOpenDemo={() => {}}
      />,
    );
    expect(html).toContain("View office demo");
    expect(html).toContain("Open Studio");
    expect(html).toContain("Design for");
    expect(html).toContain("the unexpected");
    expect(html).toContain('<footer class="welcome-bottom">');
    expect(html).toContain("© 2026 Kent Brogrammers");
    expect(html).toContain(
      'href="https://github.com/Kent-Brogrammers/ExitZero"',
    );
    expect(html).not.toMatch(/all rights reserved/i);
    expect(html).toContain("Load example building");
    expect(html).toContain("Saved Rust simulation with recorded traffic");
  });
  it("keeps the unrelated synthetic fixture disabled for a demo recording", async () => {
    const result = await loadOfficeDemo();
    const html = renderToStaticMarkup(
      <SimulationView
        building={officeDemoBuilding}
        result={result}
        allowSyntheticPreview={false}
      />,
    );
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled/);
    expect(html).toContain("API recording");
    expect(html).not.toContain("SYNTHETIC PREVIEW");
    expect(html).toContain("Show Analytics");
  });
});
