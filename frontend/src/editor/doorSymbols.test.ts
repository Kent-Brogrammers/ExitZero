import { describe, expect, it } from "vitest";
import { doorLeaves } from "./doorSymbols";
import { openingSegment } from "./geometry";
import type { Opening, Wall } from "../types/simulation";

const opening: Opening = { id: "door", wall_id: "wall", offset: 2, width: 2.4 };

describe("blueprint door symbols", () => {
  it.each([
    [
      { x: 2, y: 2 },
      { x: 14, y: 2 },
    ],
    [
      { x: 2, y: 2 },
      { x: 2, y: 14 },
    ],
    [
      { x: 2, y: 2 },
      { x: 14, y: 11 },
    ],
    [
      { x: 14, y: 11 },
      { x: 2, y: 2 },
    ],
  ])(
    "hinges two half-width leaves on the real jambs, including angled/reversed walls",
    (start, end) => {
      const wall: Wall = { id: "wall", start, end, thickness: 0.2 };
      const before = JSON.stringify({ wall, opening });
      const [a, b] = openingSegment(opening, wall);
      const leaves = doorLeaves(opening, wall);
      expect(leaves).toHaveLength(2);
      expect(leaves.map((leaf) => leaf.hinge)).toEqual([a, b]);
      for (const leaf of leaves) {
        expect(leaf.radius).toBeCloseTo(1.2);
        expect(
          leaf.hinge.x + Math.cos(leaf.startAngle) * leaf.radius,
        ).toBeCloseTo((a.x + b.x) / 2);
        expect(
          leaf.hinge.y + Math.sin(leaf.startAngle) * leaf.radius,
        ).toBeCloseTo((a.y + b.y) / 2);
        expect(
          leaf.hinge.x + Math.cos(leaf.endAngle) * leaf.radius,
        ).toBeCloseTo(leaf.tip.x);
        expect(
          leaf.hinge.y + Math.sin(leaf.endAngle) * leaf.radius,
        ).toBeCloseTo(leaf.tip.y);
      }
      expect(leaves.map((leaf) => leaf.counterclockwise)).toEqual([
        false,
        true,
      ]);
      expect(JSON.stringify({ wall, opening })).toBe(before);
    },
  );

  it.each([
    [1.2, 1],
    [1.6, 2],
    [4.8, 2],
  ])(
    "draws width %s with %s leaves without splitting the opening record",
    (width, count) => {
      const wall: Wall = {
        id: "wall",
        start: { x: 0, y: 0 },
        end: { x: 20, y: 0 },
        thickness: 0.2,
      };
      const door = { ...opening, width };
      const leaves = doorLeaves(door, wall);
      expect(leaves).toHaveLength(count);
      expect(
        leaves.every((leaf) => Math.abs(leaf.radius - width / count) < 1e-8),
      ).toBe(true);
      expect(door).toEqual({ ...opening, width });
    },
  );
});
