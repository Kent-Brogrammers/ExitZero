import { describe, expect, it, vi } from "vitest";
import {
  agentTrail,
  drawAgentInspection,
  pickAgent,
  injuryLabel,
} from "./agentInspection";
import { syntheticBuilding as building } from "./playback.fixture";
import { canvasPalette } from "../styles/canvasPalette";
import type { AnimationFrame } from "../types/simulation";

describe("agent inspection observations", () => {
  it("uses readable injury levels with the same thresholds as occupant colors", () => {
    expect(injuryLabel()).toBe("Healthy");
    expect(injuryLabel(0)).toBe("Healthy");
    expect(injuryLabel(0.01)).toBe("Healthy");
    expect(injuryLabel(0.0101)).toBe("Injured");
    expect(injuryLabel(0.4999)).toBe("Injured");
    expect(injuryLabel(0.5)).toBe("Severely Injured");
    expect(injuryLabel(1)).toBe("Severely Injured");
  });
  it("hit-tests fitted canvases at high DPI with CSS offsets and chooses the nearest occupant", () => {
    const canvas = {
      width: 1600,
      height: 900,
      getBoundingClientRect: () => ({
        left: 20,
        top: 30,
        width: 800,
        height: 450,
      }),
    } as HTMLCanvasElement;
    const frame: AnimationFrame = {
      step: 0,
      agents: [
        { id: 0, x: 1.25, y: 1.5 },
        { id: 1, x: 1.3, y: 1.5 },
      ],
    };
    expect(
      pickAgent(canvas, building, frame, { x: 307.5, y: 255 }, false),
    ).toBe(0);
    expect(pickAgent(canvas, building, frame, { x: 315, y: 255 }, false)).toBe(
      1,
    );
    expect(
      pickAgent(canvas, building, frame, { x: 20, y: 30 }, true),
    ).toBeNull();
    expect(
      pickAgent(canvas, building, null, { x: 307.5, y: 255 }, false),
    ).toBeNull();
  });

  it("does not join sparse samples through walls or missing-frame gaps", () => {
    const frames: AnimationFrame[] = [
      { step: 0, agents: [{ id: 0, x: 1.5, y: 0.8 }] },
      { step: 10, agents: [{ id: 0, x: 2.5, y: 0.8 }] },
      { step: 20, agents: [] },
      { step: 30, agents: [{ id: 0, x: 2.6, y: 0.8 }] },
      { step: 40, agents: [{ id: 0, x: 2.7, y: 0.8 }] },
    ];
    const before = structuredClone(frames);
    expect(agentTrail(building, frames, 0).map((p) => p.connect)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(frames).toEqual(before);
  });

  it("draws only the selected person's history through the playhead, with no future path", () => {
    vi.stubGlobal("window", { devicePixelRatio: 2 });
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      setLineDash: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fillText: vi.fn(),
    };
    const canvas = {
      width: 800,
      height: 600,
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const open = { ...building, walls: [], doors: [], exits: [] };
    const frames: AnimationFrame[] = [
      { step: 0, agents: [{ id: 0, x: 1, y: 1 }] },
      { step: 10, agents: [{ id: 0, x: 2, y: 1 }] },
      { step: 20, agents: [{ id: 0, x: 3, y: 1 }] },
    ];
    drawAgentInspection(
      canvas,
      open,
      frames[1]!,
      0,
      agentTrail(open, frames, 0),
      10,
      canvasPalette(canvas),
    );
    expect(context.lineTo.mock.calls).toEqual([[400, 200]]);
    expect(context.fillText).toHaveBeenCalledWith("Agent 1", 400, 172);
    context.lineTo.mockClear();
    drawAgentInspection(
      canvas,
      open,
      frames[0]!,
      0,
      agentTrail(open, frames, 0),
      0,
      canvasPalette(canvas),
    );
    expect(context.lineTo).not.toHaveBeenCalled();
    const planned = {
      step: 0,
      agents: [
        {
          id: 0,
          x: 1,
          y: 1,
          planned_path: {
            waypoints: [
              { x: 1, y: 2 },
              { x: 3, y: 2 },
            ],
            continues: false,
          },
        },
      ],
    };
    // Desired movement is supplied by the engine, independent of the future recording.
    drawAgentInspection(
      canvas,
      open,
      planned,
      0,
      agentTrail(open, frames, 0),
      0,
      canvasPalette(canvas),
    );
    expect(context.lineTo.mock.calls).toEqual([
      [200, 400],
      [600, 400],
    ]);
    expect(context.arc).toHaveBeenCalledWith(600, 400, 6, 0, Math.PI * 2);
  });
});
