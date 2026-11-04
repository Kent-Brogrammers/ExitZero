import { describe, expect, it } from "vitest";
import { trafficBins } from "./traffic";
import {
  trafficField,
  fieldPixels,
  congestionPixels,
  CONGESTION_RED_REFERENCE_SECONDS,
} from "./trafficField";

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

describe("accumulated congestion color scaling", () => {
  const localDelay = (...delays: number[]) => ({
    columns: delays.length,
    rows: 1,
    values: new Float32Array(delays),
    peak: Math.max(0, ...delays),
  });

  it("keeps brief delay cool and faint without changing source measurements", () => {
    const field = localDelay(0.5);
    const before = structuredClone(field);
    const [red, , blue, alpha] = congestionPixels(field, 5);
    expect(blue).toBeGreaterThan(red!);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(100);
    expect(field).toEqual(before);
    expect([...fieldPixels(field)]).toEqual([250, 89, 68, 220]);
  });

  it("heats persistent queues as waiting time accumulates", () => {
    const brief = congestionPixels(localDelay(1), 5);
    const longer = congestionPixels(localDelay(10), 50);
    expect(longer[0]).toBeGreaterThan(brief[0]!);
    expect(longer[3]).toBeGreaterThan(brief[3]!);
    expect([...congestionPixels(localDelay(20), 100)]).toEqual([
      250, 89, 68, 220,
    ]);
  });

  it("distinguishes accumulated queue delay and saturates a fixed scale", () => {
    const small = congestionPixels(localDelay(10), 10);
    const large = congestionPixels(
      localDelay(CONGESTION_RED_REFERENCE_SECONDS),
      10,
    );
    expect(large[0]).toBeGreaterThan(small[0]!);
    expect([...large]).toEqual([250, 89, 68, 220]);
    expect(congestionPixels(localDelay(1000), 10)).toEqual(large);
    // A severe hotspot elsewhere must not change this location's color.
    expect(congestionPixels(localDelay(10, 1000), 10).slice(0, 4)).toEqual(
      small,
    );
  });

  it("preserves a resolved queue even after a long quiet interval", () => {
    const recorded = congestionPixels(localDelay(1, 10), 10);
    expect(recorded.some((value) => value > 0)).toBe(true);
    expect(congestionPixels(localDelay(1, 10), 1000)).toEqual(recorded);
  });

  it("keeps zero-time and unavailable-duration data clear", () => {
    for (const duration of [0, -1, NaN, Infinity]) {
      expect(
        congestionPixels(localDelay(10), duration).every((v) => v === 0),
      ).toBe(true);
    }
    expect(congestionPixels(localDelay(0), 10).every((v) => v === 0)).toBe(
      true,
    );
  });
});
