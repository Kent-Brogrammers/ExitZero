import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import haunted from "../editor/presets/halloween-pursuit.json";
import school from "../editor/presets/school-emergency.json";
import { buildingPresets } from "../editor/presets";
import { buildingError } from "../editor/geometry";
import { TemplateCard } from "../templates/TemplateCard";
import {
  createTemplate,
  readTemplates,
  writeTemplates,
} from "../templates/templates";
import { createApiClient } from "../services/api";
import { PursuitMetrics } from "./PursuitMetrics";
import { SimulationView } from "./SimulationView";
import { SimulationSummary } from "./SimulationSummary";
import { createFrameSampler } from "./interpolation";
import { drawAgents } from "./drawPlayback";
import { canvasPalette } from "../styles/canvasPalette";
import { syntheticBuilding, syntheticResult } from "./playback.fixture";
import type {
  AnimationFrame,
  BuildingScenario,
  SimulationResult,
} from "../types/simulation";

// Explicit component fixtures only. Browser checks exercise actual Rust output.
const config = {
  stalker_start: { x: 1.2, y: 1 },
  stalker_speed: 1.6,
  survivor_speed: 1.3,
  capture_radius: 0.4,
  avoidance_radius: 2,
};
const building: BuildingScenario = { ...syntheticBuilding, pursuit: config };
const start: AnimationFrame = {
  ...syntheticResult.frames[0]!,
  pursuit: { stalker: config.stalker_start, escaped: 0, caught: [] },
};
const end: AnimationFrame = {
  step: 80,
  agents: [],
  pursuit: {
    stalker: { x: 1.5, y: 1 },
    escaped: 1,
    caught: [{ agent_id: 0, step: 30 }],
  },
};
const result: SimulationResult = {
  ...syntheticResult,
  status: "incomplete",
  evacuated: 1,
  remaining: 1,
  clearance_steps: null,
  frames: [start, end],
};

afterEach(() => vi.unstubAllGlobals());
describe("Halloween template and recorded outcomes", () => {
  it("provides an editable, named house with real obstructions, unblocked exits and ordinary glazing", () => {
    expect(
      buildingPresets.find((p) => p.id === "halloween-pursuit")?.label,
    ).toBe("Halloween — The Pursuit");
    expect(buildingError(haunted)).toBeNull();
    expect(haunted.walls.length).toBeGreaterThan(20);
    expect(haunted.obstructions.length).toBeGreaterThan(15);
    expect(haunted.exits).toHaveLength(3);
    expect(haunted.windows.length).toBeGreaterThan(3);
    expect(haunted.blocked_exit_ids).toEqual([]);
    const card = renderToStaticMarkup(
      <TemplateCard
        name="Halloween — The Pursuit"
        building={haunted}
        online
        busy={false}
        onEdit={() => {}}
        onRun={() => {}}
      />,
    );
    expect(card).toContain('data-halloween="true"');
    expect(card).toContain("floor plan preview");
    expect(card).toContain("Run Simulation");
  });
  it("preserves pursuit setup through local saving and JSON round trips without modifying the original", () => {
    const entry = createTemplate(
      haunted,
      "My haunted house",
      "haunt-copy",
      "layout",
    );
    let raw: string | null = null;
    const storage = {
      getItem: () => raw,
      setItem: (_key: string, value: string) => {
        raw = value;
      },
    };
    writeTemplates(storage, [entry]);
    expect(readTemplates(storage)[0]!.building).toEqual(haunted);
    entry.building.pursuit!.stalker_speed = 1;
    expect(haunted.pursuit.stalker_speed).toBe(1.6);
    expect(JSON.parse(JSON.stringify(haunted))).toEqual(haunted);
  });
  it("rejects simultaneous disasters, impossible capture ranges, unsupported window service and oversized casts", () => {
    expect(
      buildingError({
        ...building,
        disaster: { kind: "fire", center: { x: 1, y: 1 }, radius: 0.1 },
      }),
    ).toMatch(/separate|simultaneous/);
    expect(
      buildingError({
        ...building,
        pursuit: { ...config, capture_radius: 0.01 },
      }),
    ).toMatch(/capture/);
    expect(
      buildingError({
        ...building,
        pursuit: { ...config, stalker_start: { x: 10, y: 1 } },
      }),
    ).toMatch(/workspace/);
    expect(
      buildingError({
        ...haunted,
        spawn_zones: haunted.spawn_zones.map((z) => ({ ...z, count: 10 })),
      }),
    ).not.toBeNull();
    expect(
      buildingError({
        ...haunted,
        windows: [
          {
            ...haunted.windows[0]!,
            emergency_escape: school.windows[0]!.emergency_escape,
          },
        ],
      }),
    ).toMatch(/window service/);
  });
  it("separates caught from active survivors in the timeline, live display and summary", () => {
    const metrics = renderToStaticMarkup(
      <dl>
        <PursuitMetrics frame={end} final />
      </dl>,
    );
    expect(metrics).toContain("<dt>Escaped</dt><dd>1</dd>");
    expect(metrics).toContain("<dt>Caught</dt><dd>1</dd>");
    expect(metrics).toContain("<dt>Remaining</dt><dd>0</dd>");
    expect(metrics).toContain("Pursuit finished");
    const recorded = renderToStaticMarkup(
      <SimulationView
        building={building}
        result={result}
        allowSyntheticPreview={false}
      />,
    );
    expect(recorded).toContain("Red mask: stalker");
    expect(recorded).not.toContain("Remaining (final)");
    const live = renderToStaticMarkup(
      <SimulationView
        building={building}
        result={null}
        live={{ frame: start }}
      />,
    );
    expect(live).toContain("<dt>Escaped</dt><dd>0</dd>");
    expect(live).toContain("<dt>Caught</dt><dd>0</dd>");
    const summary = renderToStaticMarkup(
      <SimulationSummary
        result={result}
        synthetic={false}
        playheadTime={0}
        onClose={() => {}}
      />,
    );
    expect(summary).toContain("<dt>Caught</dt><dd>1</dd>");
    expect(summary).not.toContain("<dt>Trapped</dt>");
  });
  it("interpolates actual stalker positions while keeping capture events at their recorded times, including rewind", () => {
    const frames = [
      start,
      {
        ...end,
        step: 10,
        pursuit: { ...end.pursuit!, caught: [{ agent_id: 0, step: 10 }] },
      },
    ];
    const before = JSON.stringify(frames);
    const sample = createFrameSampler(building, frames, 0.1);
    const mid = sample(0.5)!;
    expect(mid.pursuit!.stalker.x).toBeCloseTo(1.35);
    expect(mid.pursuit!.caught).toEqual([]);
    expect(mid.agents).toHaveLength(2);
    expect(sample(1)!.pursuit!.caught).toHaveLength(1);
    expect(sample(0)!.pursuit!.caught).toEqual([]);
    expect(JSON.stringify(frames)).toBe(before);
    const acrossWall = createFrameSampler(
      building,
      [
        start,
        {
          ...end,
          step: 10,
          pursuit: { ...end.pursuit!, stalker: { x: 2.8, y: 1 } },
        },
      ],
      0.1,
    );
    expect(acrossWall(0.5)!.pursuit!.stalker).toEqual(start.pursuit!.stalker);
  });
  it("draws the stalker as a red mask at its recorded world position, separate from survivor numbers", () => {
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      ellipse: vi.fn(),
      moveTo: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
      measureText: () => ({ width: 6 }),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      font: "",
      textAlign: "",
      textBaseline: "",
    };
    const canvas = {
      width: 800,
      height: 600,
      getContext: () => context,
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
    } as unknown as HTMLCanvasElement;
    drawAgents(canvas, building, start, 1, canvasPalette(canvas), true);
    expect(context.ellipse).toHaveBeenCalledWith(
      240,
      200,
      expect.any(Number),
      expect.any(Number),
      0,
      0,
      Math.PI * 2,
    );
    expect(context.fillText.mock.calls.map((c) => c[0])).toEqual(["1", "2"]);
  });
  it("accepts real-shaped pursuit recordings and keeps legacy results compatible; rejects fabricated capture accounting", async () => {
    const client = createApiClient("/api");
    const respond = (data: SimulationResult) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify(data), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );
    respond(result);
    await expect(client.simulate(building)).resolves.toEqual(result);
    respond(syntheticResult);
    await expect(client.simulate(syntheticBuilding)).resolves.toEqual(
      syntheticResult,
    );
    respond(result);
    await expect(client.simulate(syntheticBuilding)).rejects.toMatchObject({
      code: "invalid_response",
    });
    for (const caught of [
      [{ agent_id: 0, step: 81 }],
      [
        { agent_id: 0, step: 30 },
        { agent_id: 0, step: 30 },
      ],
      [{ agent_id: 99, step: 30 }],
    ]) {
      respond({
        ...result,
        frames: [start, { ...end, pursuit: { ...end.pursuit!, caught } }],
      });
      await expect(client.simulate(building)).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });
});
