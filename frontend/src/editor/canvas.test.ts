import { describe, expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import { drawBuilding } from "./canvas";

function canvasFixture(displayWidth: number) {
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    getBoundingClientRect: vi.fn(() => ({ width: displayWidth })),
  };
  return { canvas, context, element: canvas as unknown as HTMLCanvasElement };
}

describe("Canvas drawing", () => {
  it("scales the backing buffer for high-DPI displays using CSS dimensions", () => {
    const { canvas, context, element } = canvasFixture(360);
    drawBuilding(element, example, { x: 4, y: 5 }, 2);
    expect([canvas.width, canvas.height]).toEqual([720, 480]);
    expect(context.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    expect(context.strokeRect).toHaveBeenCalledWith(98, 122, 20, 20);
    expect(context.fillText).toHaveBeenCalledWith("18 occupants", 78, 92);
  });

  it("redraws at the resized display dimensions and the new building state", () => {
    const { canvas, context, element } = canvasFixture(360);
    drawBuilding(element, example, null, 1);
    canvas.getBoundingClientRect.mockReturnValue({ width: 540 });
    drawBuilding(element, { ...example, walls: [{ x: 9, y: 8 }] }, null, 2);
    expect([canvas.width, canvas.height]).toEqual([1080, 720]);
    expect(context.setTransform).toHaveBeenLastCalledWith(1.5, 0, 0, 1.5, 0, 0);
    expect(context.fillRect).toHaveBeenCalledWith(217, 193, 22, 22);
  });

  it("does not allocate a backing buffer before the Canvas is visible", () => {
    const { canvas, context, element } = canvasFixture(0);
    drawBuilding(element, example, null, 2);
    expect(canvas.width).toBe(0);
    expect(context.setTransform).not.toHaveBeenCalled();
  });
});
