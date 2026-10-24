import { it, expect } from "vitest";
import {
  FOOT_METRES,
  gridSpacings,
  snapGridPoint,
  gridStride,
} from "./drafting";
it("uses exact feet-to-metres intervals without modifying source positions", () => {
  expect(FOOT_METRES).toBe(0.3048);
  for (const [key, feet] of [
    ["1ft", 1],
    ["2ft", 2],
    ["5ft", 5],
  ] as const)
    expect(gridSpacings[key].metres).toBe(feet * 0.3048);
  const point = { x: 1.1, y: 2.1 };
  expect(snapGridPoint(point, 0.3048, { width: 30, height: 20 })).toEqual({
    x: 4 * 0.3048,
    y: 7 * 0.3048,
  });
  expect(point).toEqual({ x: 1.1, y: 2.1 });
});
it("bounds grid density on large/far-away drawings without changing snapping intervals", () => {
  expect(gridStride(0.3048, 0.5, 1000)).toBeGreaterThan(1);
  expect(1000 / (0.3048 * gridStride(0.3048, 0.5, 1000))).toBeLessThanOrEqual(
    600,
  );
  expect(
    snapGridPoint({ x: 29.99, y: 20 }, 0.3048, { width: 30, height: 20 }).y,
  ).toBeLessThanOrEqual(20);
});
