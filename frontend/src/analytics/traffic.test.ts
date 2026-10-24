import { describe, expect, it } from "vitest";
import { trafficBins } from "./traffic";

describe("world-coordinate traffic", () => {
  it("sums weights in decimal world positions without mutating samples", () => {
    const samples = [
      { x: 1.01, y: 2.01, visits: 3 },
      { x: 1.1, y: 2.1, visits: 7 },
    ];
    const before = structuredClone(samples);
    const result = trafficBins(samples, 30, 20);
    expect(result.bins).toEqual([{ x: 1, y: 2, visits: 10 }]);
    expect(result.max).toBe(10);
    expect(samples).toEqual(before);
  });
  it("keeps boundary samples in the drawing extent and ignores invalid values", () => {
    const result = trafficBins(
      [
        { x: 30, y: 20, visits: 2 },
        { x: -1, y: 0, visits: 9 },
        { x: 31, y: 1, visits: 9 },
        { x: 1, y: 1, visits: NaN },
        { x: 1, y: 1, visits: 0 },
      ],
      30,
      20,
    );
    expect(result.bins).toEqual([{ x: 29.75, y: 19.75, visits: 2 }]);
  });
  it("handles empty traffic and bounds detail for large buildings", () => {
    expect(trafficBins([], 30, 20).max).toBe(0);
    expect(trafficBins([], 1000, 800).size).toBe(6.25);
  });
});
