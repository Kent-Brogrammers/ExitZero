import { describe, expect, it } from "vitest";
import { trafficCells } from "./traffic";

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
