// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import baseBuilding from "../../../shared/examples/building.json";
import { canvasPalette } from "../styles/canvasPalette";
import { canvasView } from "./geometry";
import { drawLayout } from "./draw";
import type { DraftingPreferences } from "./drafting";
import {
  createFloorPlanImage,
  downloadFloorPlanImage,
  floorPlanImageSize,
} from "./floorPlanImage";

vi.mock("./draw", () => ({ drawLayout: vi.fn() }));

const example = {
  ...baseBuilding,
  obstructions: [{ id: "export-desk", x: 20, y: 5, width: 2, height: 1 }],
};

const preferences: DraftingPreferences = {
  visible: false,
  snap: true,
  spacing: "5ft",
  doorMergeTolerance: 0.1,
  measurements: { walls: true, doors: false, exits: true, windows: false },
};
const furniture = new Map([[example.obstructions[0]!.id, "desk" as const]]);
let palette: ReturnType<typeof canvasPalette>;
beforeEach(() => {
  vi.mocked(drawLayout).mockClear();
  palette = canvasPalette(document.createElement("canvas"));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(new Blob(["PNG"], { type: "image/png" })),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("bounds landscape, portrait and unusually thin image sizes without allocating huge bitmaps", () => {
  expect(floorPlanImageSize({ width: 30, height: 20 })).toEqual({
    width: 3200,
    height: 2133,
  });
  expect(floorPlanImageSize({ width: 20, height: 30 })).toEqual({
    width: 2133,
    height: 3200,
  });
  expect(floorPlanImageSize({ width: 1000, height: 0.1 })).toEqual({
    width: 3200,
    height: 256,
  });
  expect(() => floorPlanImageSize({ width: NaN, height: 20 })).toThrow(
    /valid dimensions/,
  );
});

it.each([true, false])(
  "renders the full padded layout with independent overlay choices (%s), preserving source data and cleaning up",
  async (enabled) => {
    const before = JSON.stringify([example, preferences, [...furniture]]);
    const blob = await createFloorPlanImage(
      example,
      { includeGrid: enabled, includeMeasurements: enabled },
      preferences,
      furniture,
      palette,
    );
    expect(blob.type).toBe("image/png");
    const [canvas, building, selected, draft, ratio, colors, options] =
      vi.mocked(drawLayout).mock.calls[0]!;
    expect(building).toBe(example);
    expect(selected).toBeNull();
    expect(draft).toBeUndefined();
    expect(ratio).toBe(2);
    expect(colors).toBe(palette);
    expect(options?.furniture).toBe(furniture);
    expect(options?.grid).toEqual({ ...preferences, visible: enabled });
    expect(options?.showDimensions).toBe(enabled);
    expect(options?.measurements).toEqual(
      enabled
        ? preferences.measurements
        : { walls: false, doors: false, exits: false, windows: false },
    );
    const size = floorPlanImageSize(example);
    const view = canvasView(
      size.width,
      size.height,
      example,
      options?.camera,
      2,
    );
    const margin = Math.max(...example.walls.map((w) => w.thickness)) / 2;
    expect(view.x - margin * view.scale).toBeGreaterThanOrEqual(63.9);
    expect(view.y - margin * view.scale).toBeGreaterThanOrEqual(63.9);
    expect(view.x + (example.width + margin) * view.scale).toBeLessThanOrEqual(
      size.width - 63.9,
    );
    expect(view.y + (example.height + margin) * view.scale).toBeLessThanOrEqual(
      size.height - 63.9,
    );
    expect(canvas.isConnected).toBe(false);
    expect(canvas.width).toBe(0);
    expect(
      document.body.querySelector('canvas[aria-hidden="true"]'),
    ).toBeNull();
    expect(JSON.stringify([example, preferences, [...furniture]])).toBe(before);
  },
);

it("reports failed encoding and unsupported Canvas without leaving export elements behind", async () => {
  vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((callback) =>
    callback(null),
  );
  await expect(
    createFloorPlanImage(
      example,
      { includeGrid: false, includeMeasurements: true },
      preferences,
      furniture,
      palette,
    ),
  ).rejects.toThrow(/could not create the PNG/);
  expect(document.body.querySelector("canvas")).toBeNull();
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
  await expect(
    createFloorPlanImage(
      example,
      { includeGrid: false, includeMeasurements: true },
      preferences,
      furniture,
      palette,
    ),
  ).rejects.toThrow(/unavailable/);
  expect(document.body.querySelector("canvas")).toBeNull();
});

it("downloads PNG and releases the temporary URL after the click", () => {
  vi.useFakeTimers();
  const create = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:floor-plan");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("exitzero-floor-plan.png");
      expect(this.href).toBe("blob:floor-plan");
      expect(this.isConnected).toBe(true);
    });
  const blob = new Blob(["PNG"], { type: "image/png" });
  downloadFloorPlanImage(blob);
  expect(create).toHaveBeenCalledWith(blob);
  expect(click).toHaveBeenCalledOnce();
  expect(document.body.querySelector("a")).toBeNull();
  expect(revoke).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(revoke).toHaveBeenCalledWith("blob:floor-plan");
});
