import { describe, expect, it } from "vitest";
import { trafficBins } from "./traffic";
import { trafficField, fieldPixels } from "./trafficField";

describe("smoothed traffic rendering", () => {
  it("keeps empty traffic transparent", () => {
    const field = trafficField(trafficBins([], 30, 20), 30, 20, 0.6);
    expect(field.peak).toBe(0);
    expect(fieldPixels(field).every((value) => value === 0)).toBe(true);
  });
  it("uses visit weights and leaves source counts unchanged", () => {
    const data = trafficBins([{ x: 3, y: 3, visits: 5 }], 10, 10);
    const before = structuredClone(data);
    const field = trafficField(data, 10, 10, 0.6);
    const doubled = trafficField(
      trafficBins([{ x: 3, y: 3, visits: 10 }], 10, 10),
      10,
      10,
      0.6,
    );
    expect(doubled.peak).toBeCloseTo(field.peak * 2);
    expect(data).toEqual(before);
    expect(fieldPixels(field).some((value) => value > 0)).toBe(true);
  });
  it("broadens the visible field with increased smoothing and bounds image size", () => {
    const data = trafficBins([{ x: 5, y: 5, visits: 20 }], 10, 10);
    const narrow = trafficField(data, 10, 10, 0.25);
    const wide = trafficField(data, 10, 10, 1.5);
    expect(wide.values.filter((v) => v > 0).length).toBeGreaterThan(
      narrow.values.filter((v) => v > 0).length,
    );
    const large = trafficField(trafficBins([], 1000, 1000), 1000, 1000, 0.6);
    expect(large.columns).toBeLessThanOrEqual(600);
  });
});
