import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExportRenderer } from "./exportRendering";
import { createPlaybackRenderer, drawAgents } from "./drawPlayback";
import { drawLayout } from "../editor/draw";
import { congestionBins } from "../analytics/traffic";
import { congestionPixels, trafficField } from "../analytics/trafficField";
import {
  syntheticBuilding as building,
  syntheticResult as result,
} from "./playback.fixture";

vi.mock("./drawPlayback", () => ({
  createPlaybackRenderer: vi.fn(),
  drawAgents: vi.fn(),
}));
vi.mock("../editor/draw", () => ({ drawLayout: vi.fn() }));

function fixture() {
  const context = {
    createImageData: vi.fn((w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
    })),
    putImageData: vi.fn(),
  };
  const canvas = {
    ownerDocument: { createElement: () => ({ getContext: () => context }) },
  } as unknown as HTMLCanvasElement;
  return { canvas, context };
}
beforeEach(() => vi.clearAllMocks());
describe("independent export rendering", () => {
  it("accumulates sparse intervals without losing resolved queues and matches analytics at the end", () => {
    const totals = [{ x: 1, y: 1.5, crowd_delay_seconds: 10 }];
    const recording = {
      ...result,
      time_step_seconds: 0.2,
      clearance_steps: 100,
      congestion_samples: totals,
      frames: [
        { ...result.frames[0]!, step: 0, congestion_samples: [] },
        { ...result.frames[1]!, step: 50, congestion_samples: totals },
        { ...result.frames.at(-1)!, step: 100, congestion_samples: [] },
      ],
    };
    const before = structuredClone(recording);
    const { canvas, context } = fixture();
    const draw = createExportRenderer(canvas, building, recording, {
      resolution: 720,
      includeHeatmap: true,
      showAgentNumbers: false,
    });
    const pixels = () =>
      (context.putImageData.mock.lastCall![0] as { data: Uint8ClampedArray })
        .data;
    const field = trafficField(congestionBins(totals, 4, 3), 4, 3, 0.6);
    draw(10);
    expect(pixels()).toEqual(congestionPixels(field, 10));
    const earlier = pixels().slice();
    draw(19); // Same recorded interval: interpolation/redraw adds no samples.
    expect(context.putImageData).toHaveBeenCalledTimes(1);
    draw(20); // Quiet time preserves the measured queue delay.
    expect(pixels()).toEqual(congestionPixels(field, 20));
    expect(pixels()).toEqual(earlier);
    draw(10);
    expect(pixels()).toEqual(earlier);
    draw(0);
    expect(pixels().every((v) => v === 0)).toBe(true);
    expect(recording).toEqual(before);
  });
  it("samples recorded IDs at simulation timestamps, honors numbers without heatmap, and never changes frames", () => {
    const { canvas, context } = fixture(),
      render = vi.fn(),
      before = JSON.stringify(result);
    vi.mocked(createPlaybackRenderer).mockReturnValue(render);
    const draw = createExportRenderer(canvas, building, result, {
      resolution: 720,
      includeHeatmap: false,
      showAgentNumbers: true,
    });
    draw(0.5);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: [
          expect.objectContaining({ id: 0, x: 1.075 }),
          expect.objectContaining({ id: 1, x: 2.925 }),
        ],
      }),
      1,
      true,
    );
    draw(8);
    expect(render).toHaveBeenLastCalledWith(result.frames.at(-1), 1, true);
    expect(context.putImageData).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toBe(before);
  });
  it("uses backend congestion, resets its cache when seeking, and preserves recorded state", () => {
    const congestionResult = {
      ...result,
      congestion_samples: [{ x: 1, y: 1.5, crowd_delay_seconds: 0.7 }],
      frames: result.frames.map((frame, index) => ({
        ...frame,
        congestion_samples:
          index === 1 ? [{ x: 1, y: 1.5, crowd_delay_seconds: 0.7 }] : [],
      })),
    };
    const { canvas, context } = fixture(),
      before = JSON.stringify(result);
    vi.mocked(createPlaybackRenderer).mockReturnValue(vi.fn());
    const draw = createExportRenderer(canvas, building, congestionResult, {
      resolution: 1080,
      includeHeatmap: true,
      showAgentNumbers: false,
    });
    draw(0);
    const firstPixels = context.putImageData.mock.calls[0]![0] as {
      data: Uint8ClampedArray;
    };
    expect(firstPixels.data.every((v) => v === 0)).toBe(true);
    draw(1);
    const nextPixels = context.putImageData.mock.calls[1]![0] as {
      data: Uint8ClampedArray;
    };
    expect(nextPixels.data.some((v) => v > 0)).toBe(true);
    const alpha = nextPixels.data.filter((_, index) => index % 4 === 3);
    expect(Math.max(...alpha)).toBeLessThan(100);
    for (let i = 0; i < nextPixels.data.length; i += 4) {
      if (nextPixels.data[i + 3]! > 0)
        expect(nextPixels.data[i + 2]).toBeGreaterThan(nextPixels.data[i]!);
    }
    draw(1.25); // Interpolated movement never adds congestion.
    expect(context.putImageData).toHaveBeenCalledTimes(2);
    draw(0);
    expect(
      (
        context.putImageData.mock.calls[2]![0] as { data: Uint8ClampedArray }
      ).data.every((v) => v === 0),
    ).toBe(true);
    expect(drawLayout).toHaveBeenLastCalledWith(
      canvas,
      expect.anything(),
      null,
      undefined,
      1,
      expect.anything(),
      expect.objectContaining({ underlay: expect.any(Function) }),
    );
    expect(drawAgents).toHaveBeenLastCalledWith(
      canvas,
      building,
      congestionResult.frames[0],
      1,
      expect.anything(),
      false,
    );
    expect(JSON.stringify(result)).toBe(before);
  });
});
