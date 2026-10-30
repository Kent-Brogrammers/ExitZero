import { describe, expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import { drawLayout } from "./draw";
import { canvasPalette } from "../styles/canvasPalette";
import { mergeEditedDoors } from "./doorEditing";
import { setOpeningBlocked } from "./openingState";
import { measurementVisibility } from "./measurements";

function canvasFixture(width: number, height = (width * 2) / 3) {
  const strokes: { cap: string; width: number; color: string }[] = [];
  const context = {
    setTransform: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(function (this: {
      lineCap: string;
      lineWidth: number;
      strokeStyle: string;
    }) {
      strokes.push({
        cap: this.lineCap,
        width: this.lineWidth,
        color: this.strokeStyle,
      });
    }),
    strokeRect: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    setLineDash: vi.fn(),
    fillStyle: "",
    globalAlpha: 1,
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
  it("reveals small labels on selection/hover without changing geometry or overriding measurement switches", () => {
    const building = {
      ...example,
      spawn_zones: [
        { id: "tiny-zone", x: 3, y: 3, width: 1, height: 1, count: 1 },
      ],
    };
    const before = JSON.stringify(building);
    const { context, element } = canvasFixture(600);
    const options = {
      declutterLabels: true,
      showDimensions: false,
      measurements: measurementVisibility(),
    };
    const texts = () => context.fillText.mock.calls.map(([text]) => text);
    drawLayout(element, building, null, undefined, 1, undefined, options);
    expect(texts()).not.toContain("1 occupant");
    context.fillText.mockClear();
    drawLayout(element, building, null, undefined, 1, undefined, {
      ...options,
      hoveredId: "tiny-zone",
    });
    expect(texts()).toContain("1 occupant");
    context.fillText.mockClear();
    drawLayout(
      element,
      building,
      { kind: "spawn_zones", id: "tiny-zone" },
      undefined,
      1,
      undefined,
      options,
    );
    expect(texts()).toContain("1 occupant");
    context.fillText.mockClear();
    drawLayout(
      element,
      building,
      { kind: "doors", id: building.doors[0]!.id },
      undefined,
      1,
      undefined,
      {
        ...options,
        showLabels: false,
        measurements: {
          walls: false,
          doors: false,
          exits: false,
          windows: false,
        },
      },
    );
    expect(texts()).toEqual([]);
    expect(JSON.stringify(building)).toBe(before);
  });
  it("draws polygon outlines and holes instead of their bounding rectangles", () => {
    const { context, element } = canvasFixture(600);
    const polygon = [
      { x: 2, y: 2 },
      { x: 8, y: 2 },
      { x: 2, y: 8 },
    ];
    drawLayout(
      element,
      {
        ...example,
        spawn_zones: [
          { id: "poly", x: 2, y: 2, width: 6, height: 6, count: 2, polygon },
        ],
      },
      null,
    );
    expect(context.fill).toHaveBeenCalledWith("evenodd");
    expect(context.lineTo).toHaveBeenCalledWith(8, 2);
    expect(context.fillRect).not.toHaveBeenCalledWith(2, 2, 6, 6);
  });
  it("renders hazard unions above spawn fills without stacking overlapping patch opacity", () => {
    const { context, element } = canvasFixture(600);
    const fillColors: string[] = [];
    context.fill.mockImplementation(() => {
      fillColors.push(context.fillStyle);
    });
    const building = {
      ...example,
      disaster: { kind: "fire" as const, center: { x: 5, y: 5 }, radius: 1 },
    };
    drawLayout(element, building, null, undefined, 1, undefined, {
      disasterState: {
        kind: "fire",
        areas: [
          { id: 0, revision: 0, center: { x: 5, y: 5 }, radius: 1 },
          { id: 1, revision: 1, center: { x: 6, y: 5 }, radius: 1 },
        ],
      },
    });
    const index = fillColors.indexOf("#f47b3924");
    expect(fillColors.filter((c) => c === "#f47b3924")).toHaveLength(1);
    expect(fillColors.filter((c) => c === "#f47b3960")).toHaveLength(1);
    const zone = building.spawn_zones[0]!;
    const spawnIndex = context.fillRect.mock.calls.findIndex(
      (args) =>
        JSON.stringify(args) ===
        JSON.stringify([zone.x, zone.y, zone.width, zone.height]),
    );
    expect(context.fill.mock.invocationCallOrder[index]!).toBeGreaterThan(
      context.fillRect.mock.invocationCallOrder[spawnIndex]!,
    );
  });
  it("labels tornado shelters with their configured or legacy maximum", () => {
    const { context, element } = canvasFixture(600);
    drawLayout(
      element,
      {
        ...example,
        tornado_zones: [
          {
            id: "limited",
            name: "Safe room",
            x: 20,
            y: 10,
            width: 4,
            height: 4,
            max_occupants: 12,
          },
          { id: "legacy", x: 20, y: 15, width: 4, height: 4 },
        ],
      },
      null,
    );
    const labels = context.fillText.mock.calls.map(([text]) => text);
    expect(labels).toContain("Safe room · Max 12");
    expect(labels).toContain("Tornado zone · Max 50");
  });

  it.each(Array.from({ length: 16 }, (_, combination) => [combination]))(
    "renders exactly the requested wall/opening measurement combination %s",
    (combination) => {
      const building = {
        ...example,
        walls: [
          {
            id: "dimension-wall",
            start: { x: 2, y: 2 },
            end: { x: 28, y: 2 },
            thickness: 0.2,
          },
        ],
        doors: [
          {
            id: "dimension-door",
            wall_id: "dimension-wall",
            offset: 2,
            width: 1.1,
          },
        ],
        exits: [
          {
            id: "dimension-exit",
            wall_id: "dimension-wall",
            offset: 13,
            width: 1.7,
          },
        ],
        windows: [
          {
            id: "dimension-window",
            wall_id: "dimension-wall",
            offset: 7,
            width: 1.4,
          },
        ],
        spawn_zones: [],
        obstructions: [],
        blocked_exit_ids: [],
      };
      const before = JSON.stringify(building);
      const measurements = measurementVisibility({
        walls: !!(combination & 1),
        doors: !!(combination & 2),
        windows: !!(combination & 4),
        exits: !!(combination & 8),
      });
      const { context, element } = canvasFixture(600);
      drawLayout(element, building, null, undefined, 1, undefined, {
        showLabels: false,
        showDimensions: false,
        measurements,
      });
      const expected = [
        measurements.walls ? "85.3 ft" : null,
        measurements.doors ? "3.6 ft" : null,
        measurements.windows ? "4.6 ft" : null,
        measurements.exits ? "5.6 ft" : null,
      ].filter(Boolean);
      expect(context.fillText.mock.calls.map(([text]) => text).sort()).toEqual(
        expected.sort(),
      );
      expect(JSON.stringify(building)).toBe(before);
    },
  );
  it("updates live straight-wall length from the preview endpoints without changing geometry", () => {
    const { context, element } = canvasFixture(600);
    const before = JSON.stringify(example);
    const start = { x: 4, y: 5 };
    drawLayout(element, example, null, {
      shape: "wall",
      start,
      end: { x: 7, y: 5 },
    });
    expect(context.fillText.mock.calls.at(-1)?.[0]).toBe("9.84 ft");
    drawLayout(element, example, null, {
      shape: "wall",
      start,
      end: { x: 7, y: 9 },
    });
    expect(context.fillText.mock.calls.at(-1)?.[0]).toBe("16.4 ft");
    expect(JSON.stringify(example)).toBe(before);
    context.measureText.mockClear();
    context.fillText.mockClear();
    drawLayout(element, example, null);
    expect(
      context.fillText.mock.calls.some(([text]) =>
        /^\d+(\.\d+)? ft$/.test(text),
      ),
    ).toBe(false);
  });

  it("keeps live measurements the same display size across zoom and pixel densities", () => {
    const sizes: number[][] = [];
    for (const ratio of [1, 2])
      for (const zoom of [0.5, 1, 2]) {
        const { context, element } = canvasFixture(600);
        drawLayout(
          element,
          example,
          null,
          {
            shape: "wall",
            start: { x: 12, y: 8 },
            end: { x: 15, y: 12 },
          },
          ratio,
          undefined,
          { camera: { zoom, pan: { x: 17, y: -9 } } },
        );
        expect(context.font).toBe("500 12px system-ui");
        expect(context.fillText.mock.calls.at(-1)?.[0]).toBe("16.4 ft");
        expect(context.setTransform).toHaveBeenLastCalledWith(
          ratio,
          0,
          0,
          ratio,
          0,
          0,
        );
        sizes.push(context.fillRect.mock.calls.at(-1)!.slice(2));
      }
    expect(
      sizes.every((size) => JSON.stringify(size) === JSON.stringify(sizes[0])),
    ).toBe(true);
  });

  it.each([
    [
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.5 },
    ],
    [
      { x: 0.2, y: 2 },
      { x: 0.2, y: 5 },
    ],
    [
      { x: 29.8, y: 18 },
      { x: 29.8, y: 19.8 },
    ],
    [
      { x: 29.5, y: 0.1 },
      { x: 29.9, y: 0.5 },
    ],
  ])(
    "keeps edge-adjacent labels visible and clear of the unsnapped pointer (%j → %j)",
    (start, end) => {
      const { context, element } = canvasFixture(600);
      const pointer = { x: end.x - 0.2, y: end.y + 0.1 };
      drawLayout(element, example, null, {
        shape: "wall",
        start,
        end,
        pointer,
      });
      const [left, top, width, height] = context.fillRect.mock.calls.at(-1)!;
      expect(left).toBeGreaterThanOrEqual(8);
      expect(top).toBeGreaterThanOrEqual(8);
      expect(left + width).toBeLessThanOrEqual(592);
      expect(top + height).toBeLessThanOrEqual(392);
      const clearance = Math.hypot(
        Math.max(left - pointer.x * 20, 0, pointer.x * 20 - left - width),
        Math.max(top - pointer.y * 20, 0, pointer.y * 20 - top - height),
      );
      expect(clearance).toBeGreaterThanOrEqual(12 - 1e-8);
    },
  );

  it("retains a short diagonal's label when both normal offsets are clipped by the Canvas corner", () => {
    const { context, element } = canvasFixture(600);
    const end = { x: 2, y: 2 };
    drawLayout(element, example, null, {
      shape: "wall",
      start: { x: 0.5, y: 0.5 },
      end,
      pointer: end,
    });
    expect(context.fillText.mock.calls.at(-1)?.[0]).toBe("6.96 ft");
    const [left, top, width, height] = context.fillRect.mock.calls.at(-1)!;
    expect(
      Math.hypot(
        Math.max(left - 40, 0, 40 - left - width),
        Math.max(top - 40, 0, 40 - top - height),
      ),
    ).toBeGreaterThanOrEqual(12);
  });

  it.each(["wall-rectangle", "spawn", "marquee", "object-rectangle"] as const)(
    "does not add straight-wall measurements to the %s tool",
    (shape) => {
      const { context, element } = canvasFixture(600);
      drawLayout(element, example, null, {
        shape,
        start: { x: 4, y: 5 },
        end: { x: 7, y: 9 },
      });
      expect(
        context.fillText.mock.calls.some(([text]) =>
          /^\d+(\.\d+)? ft$/.test(text),
        ),
      ).toBe(false);
    },
  );

  it("does not measure an unstarted zero-length wall", () => {
    const { context, element } = canvasFixture(600);
    drawLayout(element, example, null, {
      shape: "wall",
      start: { x: 4, y: 5 },
      end: { x: 4, y: 5 },
    });
    expect(
      context.fillText.mock.calls.some(([text]) =>
        /^\d+(\.\d+)? ft$/.test(text),
      ),
    ).toBe(false);
  });

  it("keeps the active snap guide the same display size at high DPI", () => {
    const normal = canvasFixture(600);
    const retina = canvasFixture(600);
    const before = JSON.stringify(example);
    const snapTarget = {
      point: { x: 5, y: 6 },
      kind: "endpoint" as const,
      wallIds: ["wall"],
    };
    for (const [fixture, ratio] of [
      [normal, 1],
      [retina, 2],
    ] as const) {
      drawLayout(fixture.element, example, null, undefined, ratio, undefined, {
        snapTarget,
      });
      expect(fixture.context.strokeRect).toHaveBeenLastCalledWith(
        4.75,
        5.75,
        0.5,
        0.5,
      );
      expect(fixture.context.moveTo).toHaveBeenCalledWith(4.55, 6);
      expect(fixture.context.restore).toHaveBeenCalled();
    }
    expect(retina.context.strokeRect.mock.calls.at(-1)).toEqual(
      normal.context.strokeRect.mock.calls.at(-1),
    );
    expect(JSON.stringify(example)).toBe(before);
  });
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

it.each(["doors", "exits"] as const)(
  "marks blocked %s in red even with labels hidden and restores normal rendering when unblocked",
  (kind) => {
    const wall = {
      id: "wall",
      start: { x: 2, y: 2 },
      end: { x: 20, y: 2 },
      thickness: 0.2,
    };
    const b = {
      ...example,
      walls: [wall],
      doors: [],
      exits: [],
      spawn_zones: [],
      obstructions: [],
      blocked_exit_ids: [],
      [kind]: [{ id: "opening", wall_id: wall.id, offset: 2, width: 2 }],
    };
    const fixture = canvasFixture(600);
    const palette = { ...canvasPalette(fixture.element), blueprint: "1" };
    const closed = setOpeningBlocked(b, kind, "opening", true);
    drawLayout(
      fixture.element,
      closed,
      { kind, id: "opening" },
      undefined,
      2,
      palette,
      { showLabels: false, showDimensions: false },
    );
    expect(
      fixture.strokes.filter((stroke) => stroke.color === palette.danger),
    ).toHaveLength(2);
    expect(fixture.context.fillText).not.toHaveBeenCalled();
    expect(fixture.context.arc).not.toHaveBeenCalled();
    const reopened = canvasFixture(600);
    drawLayout(
      reopened.element,
      setOpeningBlocked(closed, kind, "opening", false),
      null,
      undefined,
      2,
      palette,
    );
    expect(
      reopened.strokes.some((stroke) => stroke.color === palette.danger),
    ).toBe(false);
    expect(reopened.context.arc).toHaveBeenCalledTimes(
      kind === "doors" ? 2 : 0,
    );
  },
);

it.each([false, true])(
  "keeps a merged blueprint double door open with one label (selected=%s)",
  (selected) => {
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
    drawLayout(
      element,
      merged,
      selected ? { kind: "doors", id: "kept" } : null,
      undefined,
      2,
      {
        ...canvasPalette(element),
        blueprint: "1",
      },
    );
    expect(context.arc).toHaveBeenCalledTimes(2);
    expect(context.arc.mock.calls.map((args) => args[2])).toEqual([1, 1]);
    expect(context.lineTo).not.toHaveBeenCalledWith(6, 2);
    const labels = context.fillText.mock.calls.filter(([text]) =>
      String(text).startsWith("Door"),
    );
    expect(labels).toHaveLength(1);
    expect(labels[0]![0]).toBe("Door · 6.6 ft");
  },
);

it("can hide placement labels while retaining identical building geometry and footprints", () => {
  const normal = canvasFixture(600),
    hidden = canvasFixture(600);
  const before = JSON.stringify(example);
  drawLayout(normal.element, example, null, undefined, 1, undefined, {
    showDimensions: false,
  });
  drawLayout(hidden.element, example, null, undefined, 1, undefined, {
    showLabels: false,
    showDimensions: false,
  });
  expect(normal.context.fillText.mock.calls.length).toBeGreaterThan(0);
  expect(hidden.context.fillText).not.toHaveBeenCalled();
  expect(hidden.context.lineTo.mock.calls).toEqual(
    normal.context.lineTo.mock.calls,
  );
  expect(hidden.context.fillRect.mock.calls).toEqual(
    normal.context.fillRect.mock.calls,
  );
  expect(hidden.context.strokeRect.mock.calls).toEqual(
    normal.context.strokeRect.mock.calls,
  );
  expect(JSON.stringify(example)).toBe(before);
});

it.each([false, true])(
  "fills the live spawn rectangle using the saved square constraint (invalid=%s)",
  (invalid) => {
    const { context, element } = canvasFixture(600);
    const b = {
      ...example,
      walls: [],
      doors: [],
      exits: [],
      spawn_zones: [],
      obstructions: [],
    };
    drawLayout(element, b, null, {
      start: { x: 2, y: 3 },
      end: { x: 6, y: 5 },
      shape: "spawn",
      constrain: true,
      invalid,
    });
    expect(context.fillRect).toHaveBeenCalledWith(2, 3, 4, 4);
    expect(context.strokeRect).toHaveBeenCalledWith(2, 3, 4, 4);
    expect(context.strokeStyle).toBe(
      invalid
        ? canvasPalette(element).danger
        : canvasPalette(element).selection,
    );
    expect(context.globalAlpha).toBe(1);
  },
);

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
