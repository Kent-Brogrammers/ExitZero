import { describe, expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import { drawLayout } from "./draw";
import { canvasPalette } from "../styles/canvasPalette";
import { mergeEditedDoors } from "./doorEditing";

function canvasFixture(width: number, height = (width * 2) / 3) {
  const strokes: { cap: string; width: number }[] = [];
  const context = {
    setTransform: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(function (this: { lineCap: string; lineWidth: number }) {
      strokes.push({ cap: this.lineCap, width: this.lineWidth });
    }),
    strokeRect: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    setLineDash: vi.fn(),
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
  return {
    canvas,
    context,
    strokes,
    element: canvas as unknown as HTMLCanvasElement,
  };
}

describe("freeform Canvas drawing", () => {
  it("layers traffic above spawn fills but below labels, outlines and obstacles", () => {
    const { context, element } = canvasFixture(600);
    const underlay = vi.fn();
    const building = {
      ...example,
      obstructions: [{ id: "blocker", x: 10, y: 10, width: 1, height: 1 }],
    };
    drawLayout(element, building, null, undefined, 1, undefined, { underlay });
    const overlayOrder = underlay.mock.invocationCallOrder[0]!;
    for (const zone of building.spawn_zones) {
      const fills = context.fillRect.mock.calls.flatMap((args, index) =>
        JSON.stringify(args) ===
        JSON.stringify([zone.x, zone.y, zone.width, zone.height])
          ? [index]
          : [],
      );
      expect(fills).toHaveLength(1);
      expect(
        context.fillRect.mock.invocationCallOrder[fills[0]!]!,
      ).toBeLessThan(overlayOrder);
    }
    expect(context.strokeRect.mock.invocationCallOrder[0]!).toBeGreaterThan(
      overlayOrder,
    );
    expect(context.fillText.mock.invocationCallOrder[0]!).toBeGreaterThan(
      overlayOrder,
    );
    for (const obstacle of building.obstructions) {
      const index = context.fillRect.mock.calls.findIndex(
        (args) =>
          JSON.stringify(args) ===
          JSON.stringify([
            obstacle.x,
            obstacle.y,
            obstacle.width,
            obstacle.height,
          ]),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(context.fillRect.mock.invocationCallOrder[index]!).toBeGreaterThan(
        overlayOrder,
      );
    }
  });

  it("scales the backing buffer for high-DPI displays while drawing metre coordinates", () => {
    const { canvas, context, element } = canvasFixture(360);
    drawLayout(element, example, { kind: "walls", id: "angled" }, undefined, 2);
    expect([canvas.width, canvas.height]).toEqual([720, 480]);
    expect(context.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    expect(context.setTransform).toHaveBeenLastCalledWith(24, 0, 0, 24, 0, 0);
    expect(context.moveTo).toHaveBeenCalledWith(6.5, 11);
    expect(context.lineTo).toHaveBeenCalledWith(11, 15.5);
    expect(context.arc).toHaveBeenCalledWith(
      6.5,
      11,
      expect.closeTo(5 / 12, 10),
      0,
      Math.PI * 2,
    );
    expect(context.fillText).toHaveBeenCalledWith(
      "18 occupants",
      expect.closeTo(5 + 6 / 12, 10),
      expect.closeTo(5 + 17 / 12, 10),
      expect.closeTo(5 - 8 / 12, 10),
    );
  });

  it("redraws at resized display dimensions with the current building", () => {
    const { canvas, context, element } = canvasFixture(360);
    drawLayout(element, example, null);
    canvas.getBoundingClientRect.mockReturnValue({ width: 540, height: 360 });
    const changed = structuredClone(example);
    changed.walls[5]!.end = { x: 12.25, y: 16.5 };
    drawLayout(element, changed, null, undefined, 2);
    expect([canvas.width, canvas.height]).toEqual([1080, 720]);
    expect(context.setTransform).toHaveBeenLastCalledWith(36, 0, 0, 36, 0, 0);
    expect(context.lineTo).toHaveBeenCalledWith(12.25, 16.5);
    expect(example.walls[5]!.end).toEqual({ x: 11, y: 15.5 });
  });

  it("keeps labels and selection handles the same display size across pixel densities", () => {
    const normal = canvasFixture(360);
    const retina = canvasFixture(360);
    const selection = { kind: "walls", id: "angled" } as const;
    drawLayout(normal.element, example, selection, undefined, 1);
    drawLayout(retina.element, example, selection, undefined, 2);
    expect(retina.context.fillText.mock.calls).toEqual(
      normal.context.fillText.mock.calls,
    );
    expect(retina.context.arc.mock.calls).toEqual(
      normal.context.arc.mock.calls,
    );
  });

  it.each([
    [0, 0],
    [360, 0],
  ])(
    "does not allocate a buffer for a hidden Canvas (%s × %s)",
    (width, height) => {
      const { canvas, context, element } = canvasFixture(width, height);
      drawLayout(element, example, null, undefined, 2);
      expect([canvas.width, canvas.height]).toEqual([0, 0]);
      expect(context.setTransform).not.toHaveBeenCalled();
    },
  );

  it("preserves world geometry when the workspace is letterboxed", () => {
    const { context, element } = canvasFixture(600, 400);
    drawLayout(element, { ...example, width: 20, height: 40 }, null);
    expect(context.setTransform).toHaveBeenLastCalledWith(10, 0, 0, 10, 200, 0);
  });

  it("draws openings at their declared positions along the wall", () => {
    const { context, strokes, element } = canvasFixture(600);
    drawLayout(element, example, null);
    expect(context.moveTo).toHaveBeenCalledWith(15, 5);
    expect(context.lineTo).toHaveBeenCalledWith(15, 6.4);
    expect(context.moveTo).toHaveBeenCalledWith(28, 9);
    expect(context.lineTo).toHaveBeenCalledWith(28, 10.6);
    const wallStrokes = strokes.filter(
      (stroke) => stroke.width === example.walls[0]!.thickness,
    );
    expect(wallStrokes.length).toBeGreaterThan(0);
    expect(wallStrokes.every((stroke) => stroke.cap === "round")).toBe(true);
  });
});

it("draws one width label and one blueprint swing after a door merge", () => {
  const before = {
    ...structuredClone(example),
    walls: [
      {
        id: "wall",
        start: { x: 2, y: 2 },
        end: { x: 20, y: 2 },
        thickness: 0.2,
      },
    ],
    doors: [{ id: "kept", wall_id: "wall", offset: 2, width: 1 }],
    exits: [],
    spawn_zones: [],
    obstructions: [],
    blocked_exit_ids: [],
  };
  const merged = mergeEditedDoors(before, {
    ...before,
    doors: [
      ...before.doors,
      { id: "new", wall_id: "wall", offset: 3, width: 1 },
    ],
  }).building;
  const { context, element } = canvasFixture(600);
  drawLayout(element, merged, null, undefined, 2, {
    ...canvasPalette(element),
    blueprint: "1",
  });
  expect(context.arc).toHaveBeenCalledTimes(1);
  expect(context.arc.mock.calls[0]![2]).toBe(2);
  const labels = context.fillText.mock.calls.filter(([text]) =>
    String(text).startsWith("Door"),
  );
  expect(labels).toHaveLength(1);
  expect(labels[0]![0]).toBe("Door · 2.0 m");
});

it("renders supplied freehand vertices and thickness identically at both pixel densities", () => {
  const points = [
    { x: 2, y: 2 },
    { x: 4, y: 3 },
    { x: 6, y: 2 },
  ];
  const draft = {
    start: points[0]!,
    end: points.at(-1)!,
    shape: "wall-freehand" as const,
    points,
  };
  const normal = canvasFixture(600),
    retina = canvasFixture(600);
  drawLayout(normal.element, example, null, draft, 1);
  drawLayout(retina.element, example, null, draft, 2);
  expect(normal.context.lineTo.mock.calls).toEqual(
    retina.context.lineTo.mock.calls,
  );
  expect(normal.context.lineTo).toHaveBeenLastCalledWith(6, 2);
  expect(normal.context.lineWidth).toBe(0.2);
  expect(retina.context.lineWidth).toBe(0.2);
});

it("draws a furniture symbol within the unchanged rectangular blocker footprint", () => {
  const b = {
    ...structuredClone(example),
    walls: [],
    doors: [],
    exits: [],
    spawn_zones: [],
    obstructions: [
      { id: "desk", name: "Study desk", x: 4, y: 4, width: 2, height: 1 },
    ],
  };
  const { context, element } = canvasFixture(600);
  const before = JSON.stringify(b);
  drawLayout(element, b, null, undefined, 2, canvasPalette(element), {
    furniture: new Map([["desk", "desk"]]),
  });
  expect(context.strokeRect).toHaveBeenCalledWith(4, 4, 2, 1);
  expect(context.lineTo).toHaveBeenCalledWith(5.4, 5);
  expect(
    context.fillText.mock.calls.some(
      ([text]) => String(text) === "Obstruction",
    ),
  ).toBe(false);
  expect(JSON.stringify(b)).toBe(before);
});

it("uses a plain drafting footprint for imported blockers without inferring furniture type from their names", () => {
  const b = {
    ...structuredClone(example),
    walls: [],
    doors: [],
    exits: [],
    spawn_zones: [],
    obstructions: [
      { id: "plain", name: "Desk 1", x: 4, y: 4, width: 2, height: 1 },
    ],
  };
  const { context, element } = canvasFixture(600);
  drawLayout(element, b, null, undefined, 2, {
    ...canvasPalette(element),
    blueprint: "1",
  });
  expect(context.strokeRect).toHaveBeenCalledWith(4, 4, 2, 1);
  expect(context.lineTo).not.toHaveBeenCalledWith(5.4, 5);
});

it.each([1, 2])(
  "composes underlay, grid and furniture in world-space drawing order at DPR %s",
  (ratio) => {
    const b = {
      ...structuredClone(example),
      walls: [
        {
          id: "wall",
          start: { x: 1, y: 1 },
          end: { x: 10, y: 1 },
          thickness: 0.2,
        },
      ],
      doors: [],
      exits: [],
      spawn_zones: [],
      obstructions: [{ id: "desk", x: 4, y: 4, width: 2, height: 1 }],
    };
    const before = JSON.stringify(b);
    const { context, element } = canvasFixture(600);
    const underlay = vi.fn((ctx: CanvasRenderingContext2D) => {
      expect(ctx).toBe(context);
      expect(context.fillRect.mock.calls).toEqual([
        [0, 0, 600 * ratio, 400 * ratio],
        [0, 0, 30, 20],
      ]);
      expect(context.setTransform).toHaveBeenLastCalledWith(
        20 * ratio,
        0,
        0,
        20 * ratio,
        0,
        0,
      );
      expect(context.stroke).not.toHaveBeenCalled();
      expect(context.strokeRect).not.toHaveBeenCalled();
      ctx.fillRect(3, 3, 1, 1);
    });
    drawLayout(
      element,
      b,
      null,
      undefined,
      ratio,
      { ...canvasPalette(element), blueprint: "1" },
      {
        underlay,
        grid: {
          visible: true,
          snap: false,
          spacing: "1m",
          doorMergeTolerance: 0.1,
        },
        furniture: new Map([["desk", "desk"]]),
      },
    );
    expect(underlay).toHaveBeenCalledTimes(1);
    expect(underlay.mock.invocationCallOrder[0]).toBeLessThan(
      context.stroke.mock.invocationCallOrder[0]!,
    );
    expect(underlay.mock.invocationCallOrder[0]).toBeLessThan(
      context.strokeRect.mock.invocationCallOrder[0]!,
    );
    expect(context.strokeRect).toHaveBeenCalledWith(4, 4, 2, 1);
    const furnitureLine = context.lineTo.mock.calls.findIndex(
      ([x, y]) => x === 5.4 && y === 5,
    );
    const wallLine = context.lineTo.mock.calls.findIndex(
      ([x, y]) => x === 10 && y === 1,
    );
    expect(furnitureLine).toBeGreaterThan(-1);
    expect(wallLine).toBeGreaterThan(furnitureLine);
    expect(JSON.stringify(b)).toBe(before);
  },
);
