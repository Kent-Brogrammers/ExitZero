import { describe, expect, it } from "vitest";
import { classifyOpenings, blankManualLayout } from "./classify";
import { buildDxf, type DxfDrawing } from "./convert";
import example from "../../../../shared/examples/building.json";
const stroke = (
  id: string,
  layer: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) => ({
  id,
  layer,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  thickness: null,
});
const drawing: DxfDrawing = {
  units: 6,
  warnings: [],
  strokes: [
    stroke("a", "WALLS", 0, 0, 4, 0),
    stroke("b", "WALLS", 5, 0, 10, 0),
    stroke("c", "WALLS", 0, 0, 0, 6),
  ],
};
const options = { layers: ["WALLS"], scale: 1, thickness: 0.2, maxGap: 3 };
function guess(source: DxfDrawing) {
  const built = buildDxf(source, options, example);
  return Object.values(
    classifyOpenings(source, options, built.building, built.openings),
  )[0]!;
}
describe("automatic DXF suggestions", () => {
  it("recognizes an exterior door symbol and labels its exit designation as a heuristic", () => {
    const value = guess({
      ...drawing,
      strokes: [...drawing.strokes, stroke("d", "DOORS", 4, 0, 4, 1)],
    });
    expect(value.role).toBe("exit");
    expect(value.confidence).toBe("medium");
    expect(value.reason).toContain("does not prove");
  });
  it("keeps a window gap sealed and never opens an unknown gap", () => {
    expect(
      guess({
        ...drawing,
        strokes: [...drawing.strokes, stroke("w", "WINDOWS", 4, 0, 5, 0)],
      }).role,
    ).toBe("closed");
    expect(guess(drawing).confidence).toBe("uncertain");
    expect(guess(drawing).role).toBe("closed");
  });
  it("uses explicit exit-layer evidence and seals conflicting evidence", () => {
    const source = {
      ...drawing,
      strokes: [...drawing.strokes, stroke("e", "EMERGENCY_EXIT", 4, 0, 5, 0)],
    };
    expect(guess(source).role).toBe("exit");
    expect(
      guess({
        ...source,
        strokes: [...source.strokes, stroke("w", "WINDOWS", 4, 0, 5, 0)],
      }).role,
    ).toBe("closed");
  });
  it("does not call an interior door an exit", () => {
    const source = {
      ...drawing,
      strokes: [
        ...drawing.strokes,
        stroke("a2", "WALLS", 0, -2, 10, -2),
        stroke("d", "DOORS", 4, 0, 4, 1),
      ],
    };
    expect(guess(source).role).toBe("door");
  });
  it("creates an empty manual layout without mutating the imported building", () => {
    const before = structuredClone(example);
    const blank = blankManualLayout({
      ...example,
      opening_events: [{ step: 5, opening_id: "old-exit", blocked: true }],
    });
    expect(blank.opening_events).toEqual([]);
    expect(blank.walls).toEqual([]);
    expect(blank.exits).toEqual([]);
    expect(blank.doors).toEqual([]);
    expect(blank.spawn_zones).toEqual([]);
    expect(blank.width).toBe(30);
    expect(blank.height).toBe(20);
    expect(example).toEqual(before);
  });
});
