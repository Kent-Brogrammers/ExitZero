import { expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import { FOOT_METRES } from "../utils/units";
import { canvasView } from "./geometry";
import { scaleBar } from "./scaleBar";

it("uses readable feet intervals with their actual screen lengths", () => {
  for (const [pixels, label] of [
    [30, "10 ft"],
    [60, "5 ft"],
    [300, "1 ft"],
    [3000, "0.1 ft"],
  ] as const) {
    const bar = scaleBar(pixels)!;
    expect(bar.label).toBe(label);
    expect(bar.width).toBeCloseTo(91.44);
  }
});

it("uses metre intervals at the same world scale when metric is selected", () => {
  expect(scaleBar(30, 112, "metric")).toEqual({ width: 60, label: "2 m" });
  expect(scaleBar(300, 112, "metric")).toEqual({ width: 60, label: "0.2 m" });
});

it("matches world distances through zoom, pan, resize, and high-DPI backing sizes", () => {
  for (const [width, height] of [
    [1366, 768],
    [760, 540],
  ] as const) {
    for (const zoom of [0.1, 1, 20]) {
      let baseline: ReturnType<typeof scaleBar> = null;
      for (const ratio of [1, 2, 3]) {
        const view = canvasView(
          width * ratio,
          height * ratio,
          example,
          { zoom, pan: { x: 150, y: -90 } },
          ratio,
        );
        const bar = scaleBar(view.scale / ratio)!;
        const feet = Number(bar.label.replaceAll(",", "").split(" ")[0]);
        const worldStart = view.x / ratio;
        const worldEnd = (view.x + feet * FOOT_METRES * view.scale) / ratio;
        expect(bar.width).toBeCloseTo(worldEnd - worldStart);
        expect(bar.width).toBeGreaterThan(0);
        expect(bar.width).toBeLessThanOrEqual(112);
        if (baseline) {
          expect(bar.label).toBe(baseline.label);
          expect(bar.width).toBeCloseTo(baseline.width);
        }
        baseline = bar;
      }
    }
  }
});

it("fits a narrow drawing area and hides when no valid scale fits", () => {
  expect(scaleBar(30, 64)!.width).toBeLessThanOrEqual(64);
  for (const value of [0, -1, NaN, Infinity])
    expect(scaleBar(value)).toBeNull();
  for (const width of [0, 47, NaN, Infinity])
    expect(scaleBar(30, width)).toBeNull();
});
