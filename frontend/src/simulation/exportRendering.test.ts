import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExportRenderer } from "./exportRendering";
import { createPlaybackRenderer, drawAgents } from "./drawPlayback";
import { drawLayout } from "../editor/draw";
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
  it("uses progressive recorded trails, resets its own cache when seeking, and passes frame opening/hazard state to the shared renderer", () => {
    const { canvas, context } = fixture(),
      before = JSON.stringify(result);
    vi.mocked(createPlaybackRenderer).mockReturnValue(vi.fn());
    const draw = createExportRenderer(canvas, building, result, {
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
    draw(1.25); // Interpolated movement does not invent traffic observations.
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
      result.frames[0],
      1,
      expect.anything(),
      false,
    );
    expect(JSON.stringify(result)).toBe(before);
  });
});
