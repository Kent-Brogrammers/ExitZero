import { describe, expect, it } from "vitest";
import { congestionBins, trafficCells, trafficBins } from "./traffic";

it("renders fractional backend delay weights without converting them into visit counts", () => {
  const samples = [
    { x: 1.01, y: 2.01, crowd_delay_seconds: 0.15 },
    { x: 1.1, y: 2.1, crowd_delay_seconds: 0.25 },
    { x: 3, y: 3, crowd_delay_seconds: 0 },
    { x: 3, y: 3, crowd_delay_seconds: -1 },
  ];
  expect(congestionBins(samples, 30, 20).bins).toEqual([
    { x: 1, y: 2, visits: 0.4 },
  ]);
});

describe("world-coordinate weighted traffic", () => {
  it("adds visits rather than counting samples, preserving their coordinate orientation", () => {
    const samples = [
      { x: 3.1, y: 1.1, visits: 2 },
      { x: 3.1, y: 1.1, visits: 8 },
      { x: 9, y: 4, visits: 1 },
    ];
    const before = structuredClone(samples);
    const cells = trafficCells(samples, 12, 6);
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({ x: 3, y: 1, visits: 10 });
    expect(cells[1]).toMatchObject({ x: 9, y: 4, visits: 1 });
    expect(cells.reduce((sum, c) => sum + c.visits, 0)).toBe(11);
    expect(samples).toEqual(before);
  });
  it("keeps boundary samples within rectangular metre extents", () => {
    const cells = trafficCells(
      [
        { x: 30, y: 20, visits: 50 },
        { x: 0, y: 0, visits: 3 },
      ],
      30,
      20,
    );
    for (const cell of cells) {
      expect(cell.x + cell.width).toBeLessThanOrEqual(30);
      expect(cell.y + cell.height).toBeLessThanOrEqual(20);
    }
    expect(cells.reduce((sum, c) => sum + c.visits, 0)).toBe(53);
  });
  it("handles empty traffic and ignores invalid values without fabricating zeros", () => {
    expect(trafficCells([], 30, 20)).toEqual([]);
    expect(
      trafficCells(
        [
          { x: -1, y: 0, visits: 1 },
          { x: 1, y: 1, visits: 0 },
          { x: NaN, y: 1, visits: 1 },
        ],
        30,
        20,
      ),
    ).toEqual([]);
  });
});

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
