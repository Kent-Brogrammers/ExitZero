import { describe, expect, it, vi } from "vitest";
import { canvasView } from "../editor/geometry";
import { canvasPalette } from "../styles/canvasPalette";
import { drawLayout } from "../editor/draw";
import {
  createPlaybackRenderer,
  drawPlayback,
  worldToCanvas,
} from "./drawPlayback";
import { syntheticBuilding, syntheticResult } from "./playback.fixture";

function fixture(width: number, height: number) {
  const context = {
    drawImage: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    setLineDash: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    font: "",
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    getBoundingClientRect: vi.fn(() => ({ width, height })),
  };
  return { context, canvas, element: canvas as unknown as HTMLCanvasElement };
}

describe("playback Canvas", () => {
  it("shows exact initial markers only before a recording, never as stationary ghost agents during playback", () => {
    const { context, element } = fixture(600, 400);
    const building = {
      ...syntheticBuilding,
      walls: [],
      doors: [],
      exits: [],
      windows: [],
      spawn_zones: [],
      obstructions: [],
      placed_occupants: [{ id: "person", x: 2, y: 2 }],
    };
    drawLayout(element, building, null);
    expect(context.arc).toHaveBeenCalledTimes(1);
    context.arc.mockClear();
    drawPlayback(element, building, { step: 10, agents: [] }, 1);
    expect(context.arc).not.toHaveBeenCalled();
    drawPlayback(
      element,
      building,
      { step: 0, agents: [{ id: 0, x: 2, y: 2 }] },
      1,
    );
    expect(context.arc).toHaveBeenCalledTimes(1);
  });
  it("refreshes the cached floor plan when initial markers give way to recorded agents", () => {
    const main = fixture(600, 400),
      cached = fixture(600, 400);
    const building = {
      ...syntheticBuilding,
      walls: [],
      doors: [],
      exits: [],
      windows: [],
      spawn_zones: [],
      obstructions: [],
      placed_occupants: [{ id: "person", x: 2, y: 2 }],
    };
    const render = createPlaybackRenderer(
      main.element,
      building,
      cached.element,
    );
    render(null, 1);
    expect(main.context.arc).toHaveBeenCalledTimes(1);
    main.context.arc.mockClear();
    render({ step: 10, agents: [] }, 1);
    expect(main.context.arc).not.toHaveBeenCalled();
    expect(cached.context.drawImage).toHaveBeenCalledTimes(2);
  });
  it("keeps closed doors visible as shut panels in both normal and blueprint playback", () => {
    for (const blueprint of ["0", "1"]) {
      const { context, element } = fixture(600, 400);
      const palette = { ...canvasPalette(element), blueprint };
      const frame = { step: 1, agents: [], blocked_opening_ids: ["door"] };
      drawPlayback(element, syntheticBuilding, frame, 1, palette, false, {
        hazardMode: "filled",
        showBlockedLabels: true,
        showTraffic: true,
      });
      expect(
        context.fillText.mock.calls.some(([text]) =>
          String(text).startsWith("Closed door"),
        ),
      ).toBe(true);
      if (blueprint === "1") {
        const closedArcs = context.arc.mock.calls.length;
        context.arc.mockClear();
        drawPlayback(
          element,
          syntheticBuilding,
          { ...frame, blocked_opening_ids: [] },
          1,
          palette,
        );
        expect(context.arc.mock.calls.length).toBeGreaterThan(closedArcs);
      }
    }
  });
  it("keeps numbered dots compact at small world scales and restores physical display radii when off", () => {
    const { context, element } = fixture(600, 400);
    const building = { ...syntheticBuilding, width: 1000, height: 1000 };
    const frame = {
      step: 0,
      agents: [
        { id: 0, x: 1, y: 1 },
        { id: 9999, x: 500, y: 500 },
      ],
    };
    drawPlayback(element, building, frame, 2, undefined, true);
    expect(context.arc.mock.calls.map((args) => args[2])).toEqual([17, 28]);
    expect(context.fillText.mock.calls.some(([text]) => text === "10000")).toBe(
      true,
    );
    context.arc.mockClear();
    drawPlayback(element, building, frame, 2);
    expect(context.arc.mock.calls.every((args) => Number(args[2]) < 1)).toBe(
      true,
    );
  });
  it("numbers stable IDs starting at one, follows positions, and restores plain dots when toggled off", () => {
    const main = fixture(600, 400),
      cache = fixture(600, 400);
    const render = createPlaybackRenderer(
      main.element,
      syntheticBuilding,
      cache.element,
    );
    const frame = {
      step: 0,
      agents: [
        { id: 0, x: 1, y: 1 },
        { id: 7, x: 2, y: 2 },
      ],
    };
    render(frame, 2);
    expect(
      main.context.fillText.mock.calls.filter(([text]) =>
        /^\d+$/.test(String(text)),
      ),
    ).toEqual([]);
    main.context.fillText.mockClear();
    render(frame, 2, true);
    const view = canvasView(
      main.canvas.width,
      main.canvas.height,
      syntheticBuilding,
    );
    expect(main.context.fillText).toHaveBeenCalledWith(
      "1",
      worldToCanvas(frame.agents[0]!, view).x,
      worldToCanvas(frame.agents[0]!, view).y,
    );
    expect(main.context.fillText).toHaveBeenCalledWith(
      "8",
      worldToCanvas(frame.agents[1]!, view).x,
      worldToCanvas(frame.agents[1]!, view).y,
    );
    main.context.fillText.mockClear();
    render({ step: 5, agents: [{ id: 7, x: 2.5, y: 1.5 }] }, 2, true);
    const moved = worldToCanvas({ x: 2.5, y: 1.5 }, view);
    expect(main.context.fillText).toHaveBeenCalledExactlyOnceWith(
      "8",
      moved.x,
      moved.y,
    );
    main.context.fillText.mockClear();
    render(frame, 2, false);
    expect(main.context.fillText).not.toHaveBeenCalled();
    expect(cache.context.drawImage).toHaveBeenCalledTimes(1);
    expect(frame.agents.map((a) => a.id)).toEqual([0, 7]);
  });
  it("allows the welcome preview to omit dimensions while editor/playback keep the default caption", () => {
    const normal = fixture(600, 400),
      welcome = fixture(600, 400);
    drawLayout(normal.element, syntheticBuilding, null);
    drawLayout(
      welcome.element,
      syntheticBuilding,
      null,
      undefined,
      2,
      undefined,
      { showDimensions: false },
    );
    const dimensions = "13.1 × 9.8 ft";
    expect(
      normal.context.fillText.mock.calls.some(([text]) => text === dimensions),
    ).toBe(true);
    expect(
      welcome.context.fillText.mock.calls.some(([text]) => text === dimensions),
    ).toBe(false);
    expect(welcome.canvas.width).toBe(1200);
    expect(welcome.context.lineTo).toHaveBeenCalled();
  });
  it("refreshes the cached floor plan when a passage closes or reopens", () => {
    const main = fixture(600, 400),
      cache = fixture(600, 400);
    const render = createPlaybackRenderer(
      main.element,
      syntheticBuilding,
      cache.element,
    );
    const frame = syntheticResult.frames[0]!;
    render({ ...frame, blocked_opening_ids: [] }, 1);
    render({ ...frame, blocked_opening_ids: ["door"] }, 1);
    expect(cache.context.drawImage).toHaveBeenCalledTimes(2);
    render({ ...frame, blocked_opening_ids: ["door"] }, 1);
    expect(cache.context.drawImage).toHaveBeenCalledTimes(2);
    render({ ...frame, blocked_opening_ids: [] }, 1);
    expect(cache.context.drawImage).toHaveBeenCalledTimes(3);
  });
  it("caches the static layout until the display size or pixel ratio changes", () => {
    const main = fixture(600, 400),
      cache = fixture(600, 400);
    const render = createPlaybackRenderer(
      main.element,
      syntheticBuilding,
      cache.element,
    );
    render(syntheticResult.frames[0]!, 1);
    const walls = main.context.lineTo.mock.calls.length;
    expect(cache.context.drawImage).toHaveBeenCalledOnce();
    render(syntheticResult.frames[1]!, 1);
    expect(main.context.lineTo).toHaveBeenCalledTimes(walls);
    expect(main.context.drawImage).toHaveBeenCalledWith(cache.element, 0, 0);
    render(syntheticResult.frames[1]!, 2);
    expect(cache.context.drawImage).toHaveBeenCalledTimes(2);
    expect(main.canvas.width).toBe(1200);
    main.canvas.getBoundingClientRect.mockReturnValue({
      width: 300,
      height: 200,
    });
    render(syntheticResult.frames[1]!, 2);
    expect(cache.context.drawImage).toHaveBeenCalledTimes(3);
    expect(main.canvas.width).toBe(600);
  });

  it("batches occupant circles into one fill/stroke operation", () => {
    const { context, element } = fixture(600, 400);
    const frame = {
      ...syntheticResult.frames[0]!,
      agents: Array.from({ length: 1000 }, (_, id) => ({ id, x: 1, y: 1 })),
    };
    const building = {
      ...syntheticBuilding,
      walls: [],
      spawn_zones: [],
      doors: [],
      exits: [],
    };
    drawPlayback(element, building, frame, 1);
    expect(context.arc).toHaveBeenCalledTimes(1000);
    expect(context.fill).toHaveBeenCalledOnce();
    expect(context.stroke).toHaveBeenCalledOnce();
  });

  it("draws injury groups, agent numbers, and recorded window queue rings together", () => {
    const { context, element } = fixture(600, 400);
    const building = {
      ...syntheticBuilding,
      walls: [],
      spawn_zones: [],
      doors: [],
      exits: [],
    };
    drawPlayback(
      element,
      building,
      {
        step: 1,
        agents: [
          { id: 1, x: 1, y: 1, injury: 0.2 },
          { id: 2, x: 2, y: 1, injury: 0.6 },
        ],
        window_states: [
          {
            window_id: "pane",
            state: "broken",
            preparation_ready_step: 1,
            queue_agent_ids: [1],
            traversing_agent_id: 2,
            traversal_earliest_finish_step: 31,
          },
        ],
      },
      1,
      undefined,
      true,
    );
    expect(context.arc).toHaveBeenCalledTimes(4);
    expect(context.fill).toHaveBeenCalledTimes(2);
    expect(context.stroke).toHaveBeenCalledTimes(4);
    expect(context.fillText).toHaveBeenCalledWith(
      "2",
      expect.any(Number),
      expect.any(Number),
    );
    expect(context.fillText).toHaveBeenCalledWith(
      "3",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("maps fractional world coordinates with a top-left origin and letterboxing", () => {
    const view = canvasView(600, 400, syntheticBuilding);
    expect(worldToCanvas({ x: 1.25, y: 1.5 }, view).x).toBeCloseTo(200);
    expect(worldToCanvas({ x: 1.25, y: 1.5 }, view).y).toBeCloseTo(200);
    expect(worldToCanvas({ x: 0, y: 0 }, view).x).toBeCloseTo(100 / 3);
    expect(worldToCanvas({ x: 4, y: 3 }, view).y).toBeCloseTo(400);
  });

  it("renders real-valued occupant positions and physical radii at device pixel ratio 2", () => {
    const { context, canvas, element } = fixture(600, 400);
    drawPlayback(element, syntheticBuilding, syntheticResult.frames[0]!, 2);
    expect([canvas.width, canvas.height]).toEqual([1200, 800]);
    expect(context.arc).toHaveBeenCalledWith(
      expect.closeTo(400),
      expect.closeTo(400),
      expect.closeTo(32),
      0,
      Math.PI * 2,
    );
    expect(context.arc).toHaveBeenCalledTimes(2);
    expect(context.restore).toHaveBeenCalledOnce();
  });

  it("keeps occupant and layout coordinates aligned after Canvas resizing", () => {
    const { context, canvas, element } = fixture(600, 400);
    drawPlayback(element, syntheticBuilding, syntheticResult.frames[0]!, 1);
    canvas.getBoundingClientRect.mockReturnValue({ width: 300, height: 200 });
    context.arc.mockClear();
    drawPlayback(element, syntheticBuilding, syntheticResult.frames[0]!, 1);
    expect([canvas.width, canvas.height]).toEqual([300, 200]);
    expect(context.arc).toHaveBeenCalledWith(
      expect.closeTo(100),
      expect.closeTo(100),
      expect.closeTo(8),
      0,
      Math.PI * 2,
    );
  });

  it("renders just the layout when there are no frames and no occupants after the final frame", () => {
    const { context, element } = fixture(600, 400);
    drawPlayback(element, syntheticBuilding, null, 1);
    expect(context.lineTo).toHaveBeenCalled();
    expect(context.arc).not.toHaveBeenCalled();
    drawPlayback(element, syntheticBuilding, syntheticResult.frames.at(-1)!, 1);
    expect(context.arc).not.toHaveBeenCalled();
  });

  it("does not draw occupants into an unmeasured or hidden Canvas", () => {
    const { context, element } = fixture(0, 0);
    drawPlayback(element, syntheticBuilding, syntheticResult.frames[0]!, 2);
    expect(context.arc).not.toHaveBeenCalled();
  });
});
