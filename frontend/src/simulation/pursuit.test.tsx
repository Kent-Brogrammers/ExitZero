import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import haunted from "../editor/presets/halloween-pursuit.json";
import { buildingPresets, halloweenPreset } from "../editor/presets";
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
import { AgentChat } from "./AgentChat";
import { communicationMessage, communicationsAtTime } from "./communication";
import { canvasView } from "../editor/geometry";
import { canvasPalette } from "../styles/canvasPalette";
import { syntheticBuilding, syntheticResult } from "./playback.fixture";
import type {
  AnimationFrame,
  BuildingScenario,
  SimulationResult,
  PursuitEvent,
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
  it("provides an editable house with blocked routes and explicitly configured emergency windows", () => {
    expect(halloweenPreset.label).toBe("Halloween — The Pursuit");
    expect(buildingPresets.some((p) => p.building.pursuit)).toBe(false);
    expect(buildingError(haunted)).toBeNull();
    expect(haunted.walls.length).toBeGreaterThan(20);
    expect(haunted.obstructions.length).toBeGreaterThan(15);
    expect(haunted.exits).toHaveLength(3);
    expect(haunted.windows.length).toBeGreaterThan(3);
    expect(haunted.blocked_exit_ids).toEqual(["haunt-exit-garage-side"]);
    expect(haunted.opening_events).toHaveLength(2);
    expect(haunted.windows.filter((w) => "emergency_escape" in w)).toHaveLength(
      2,
    );
    expect(haunted.window_escape_context.floor_elevation_metres).toBe(0);
    const card = renderToStaticMarkup(
      <TemplateCard
        name="Halloween — The Pursuit"
        building={haunted as BuildingScenario}
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
      haunted as BuildingScenario,
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
  it("rejects simultaneous disasters, impossible capture ranges and oversized casts, while allowing window service", () => {
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
            emergency_escape: haunted.windows[0]!.emergency_escape,
          },
        ],
      }),
    ).toBeNull();
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
    canvas.width = 80;
    canvas.height = 60;
    context.arc.mockClear();
    drawAgents(canvas, building, start, 1, canvasPalette(canvas));
    expect(context.arc.mock.calls[0]![2]).toBe(context.arc.mock.calls[3]![2]);
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

it("keeps recorded caught markers fixed, red and crossed, and removes them on rewind", () => {
  const colors: string[] = [];
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    ellipse: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fill: vi.fn(() => colors.push(context.fillStyle)),
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
  const caught = { agent_id: 0, step: 10, position: { x: 1, y: 1 } };
  const frame = {
    ...end,
    step: 10,
    pursuit: { ...end.pursuit!, caught: [caught], events: [] },
  };
  const frames = [start, frame];
  const raw = JSON.stringify(frames);
  const sample = createFrameSampler(building, frames, 0.1);
  drawAgents(canvas, building, sample(0.99), 1, canvasPalette(canvas));
  expect(context.lineTo).not.toHaveBeenCalled();
  drawAgents(canvas, building, sample(1), 1, canvasPalette(canvas), true);
  expect(context.lineTo).toHaveBeenCalledTimes(2);
  expect(colors).toContain("#ed5a65");
  const view = canvasView(800, 600, building);
  expect(context.arc).toHaveBeenCalledWith(
    view.x + view.scale,
    view.y + view.scale,
    expect.any(Number),
    0,
    Math.PI * 2,
  );
  expect(context.fillText.mock.calls.some((c) => c[0] === "1")).toBe(true);
  context.lineTo.mockClear();
  drawAgents(canvas, building, sample(2), 1, canvasPalette(canvas));
  expect(context.lineTo).toHaveBeenCalledTimes(2);
  context.lineTo.mockClear();
  drawAgents(canvas, building, sample(0), 1, canvasPalette(canvas));
  expect(context.lineTo).not.toHaveBeenCalled();
  expect(JSON.stringify(frames)).toBe(raw);
});

it("renders genuine sightings and grouped warnings with stable numbers at recorded times", () => {
  const events: PursuitEvent[] = [
    {
      step: 4,
      event_type: "sighting",
      sender_id: 0,
      recipient_ids: [],
      position: { x: 1, y: 1 },
    },
    {
      step: 5,
      event_type: "warning",
      sender_id: 0,
      recipient_ids: [1, 2],
      position: { x: 1, y: 1 },
    },
    {
      step: 7,
      event_type: "warning",
      sender_id: 2,
      recipient_ids: [3],
      position: { x: 1, y: 1 },
    },
  ];
  const recording = {
    ...result,
    frames: [start, { ...end, pursuit: { ...end.pursuit!, events } }],
  };
  expect(communicationMessage(events[0]!, building)).toBe(
    "Agent 1 spotted the killer.",
  );
  expect(communicationMessage(events[1]!, building)).toContain(
    "Agent 1 warned Agents 2 and 3",
  );
  const chat = (time: number) =>
    renderToStaticMarkup(
      <AgentChat
        building={building}
        result={recording}
        time={time}
        onClose={() => {}}
      />,
    );
  expect(chat(0.39)).not.toContain("<li>");
  expect(communicationsAtTime(recording, 0.5).events).toHaveLength(2);
  expect(chat(0.5)).toContain("00:00.50");
  expect(chat(0.7)).toContain("Agent 3 warned Agent 4");
  expect(chat(0.5)).not.toContain("Agent 3 warned Agent 4");
  expect(chat(0.5)).not.toContain("Communications were not recorded");
  const live = renderToStaticMarkup(
    <AgentChat
      building={building}
      result={null}
      liveFrame={{ ...end, pursuit: { ...end.pursuit!, events } }}
      time={0.5}
      onClose={() => {}}
    />,
  );
  expect(live).toContain("Agent 1 warned Agents 2 and 3");
  expect(live).not.toContain("Agent 3 warned Agent 4");
  expect(
    renderToStaticMarkup(
      <AgentChat
        building={building}
        result={{
          ...result,
          frames: [{ ...end, pursuit: { ...end.pursuit!, events: [] } }],
        }}
        time={8}
        onClose={() => {}}
      />,
    ),
  ).toContain("No killer sightings or warnings");
});

it("validates optional capture positions and warning records through the shared API contract", async () => {
  const events: PursuitEvent[] = [
    {
      step: 4,
      event_type: "sighting",
      sender_id: 0,
      recipient_ids: [],
      position: { x: 1, y: 1 },
    },
    {
      step: 5,
      event_type: "warning",
      sender_id: 0,
      recipient_ids: [1],
      position: { x: 1, y: 1 },
    },
  ];
  const full: SimulationResult = {
    ...result,
    frames: [
      { ...start, pursuit: { ...start.pursuit!, events: [] } },
      {
        ...end,
        pursuit: {
          ...end.pursuit!,
          caught: [{ agent_id: 0, step: 30, position: { x: 1, y: 1 } }],
          events,
        },
      },
    ],
  };
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
  respond(full);
  await expect(client.simulate(building)).resolves.toEqual(full);
  for (const change of [
    (r: SimulationResult) => {
      r.frames.at(-1)!.pursuit!.caught[0]!.position!.x = building.width + 1;
    },
    (r: SimulationResult) => {
      r.frames.at(-1)!.pursuit!.events![0]!.step = 81;
    },
    (r: SimulationResult) => {
      r.frames.at(-1)!.pursuit!.events![1]!.recipient_ids = [0];
    },
    (r: SimulationResult) => {
      r.frames.at(-1)!.pursuit!.events!.push({ ...events[1]!, step: 6 });
    },
    (r: SimulationResult) => {
      r.frames.at(-1)!.pursuit!.events![1]!.recipient_ids = [5];
    },
  ]) {
    const invalid = structuredClone(full);
    change(invalid);
    respond(invalid);
    await expect(client.simulate(building)).rejects.toMatchObject({
      code: "invalid_response",
    });
  }
});
