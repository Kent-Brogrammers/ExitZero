import { describe, expect, it } from "vitest";
import {
  parseDxf,
  buildDxf,
  applyOpenings,
  dxfScale,
  suggestedWallLayers,
  type DxfDrawing,
} from "./convert";
import example from "../../../../shared/examples/building.json";
import { buildingError } from "../geometry";
const stroke = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  layer = "WALLS",
) => ({
  id,
  layer,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  thickness: null,
});
const drawing: DxfDrawing = {
  units: 4,
  warnings: [],
  strokes: [
    stroke("a", 0, 0, 4000, 0),
    stroke("b", 5000, 0, 10000, 0),
    stroke("c", 0, 0, 0, 6000),
    stroke("text", -10000, -10000, 50000, 50000, "TITLE_BLOCK"),
  ],
};
const options = { layers: ["WALLS"], scale: 0.001, thickness: 0.2, maxGap: 3 };
describe("assisted DXF import", () => {
  it("replaces wall-attached windows with the imported geometry and preserves the original for Undo", () => {
    const base = {
      ...structuredClone(example),
      windows: [
        {
          id: "old-window",
          wall_id: example.walls[0]!.id,
          offset: 1,
          width: 1,
        },
      ],
    };
    const before = structuredClone(base);
    const { building } = buildDxf(drawing, options, base);
    expect(building.windows).toEqual([]);
    expect(buildingError(building, false)).toBeNull();
    expect(base).toEqual(before);
  });
  it("converts millimetres, flips Y, excludes unrelated layers, and detects a one-metre opening", () => {
    const { building, openings } = buildDxf(drawing, options, example);
    expect(building.width).toBe(12);
    expect(building.height).toBe(8);
    expect(building.walls).toHaveLength(2);
    expect(openings).toHaveLength(1);
    expect(openings[0]!.width).toBeCloseTo(1);
    expect(building.spawn_zones).toEqual([]);
    expect(building.exits).toEqual([]);
    expect(buildingError(building, false)).toBeNull();
  });
  it("requires review and preserves door/exit roles without changing contracts", () => {
    const { building, openings } = buildDxf(drawing, options, example);
    const id = openings[0]!.id;
    expect(() => applyOpenings(building, openings, {})).toThrow("Review every");
    const reviewed = applyOpenings(building, openings, { [id]: "exit" });
    expect(reviewed.exits).toHaveLength(1);
    expect(reviewed.doors).toHaveLength(0);
    expect(buildingError(reviewed, false)).toBeNull();
    expect(
      applyOpenings(building, openings, { [id]: "closed" }).doors,
    ).toHaveLength(0);
  });
  it("does not infer openings across large gaps; rejects incorrect scale and oversized extents", () => {
    expect(
      buildDxf(drawing, { ...options, maxGap: 0 }, example).openings,
    ).toHaveLength(0);
    expect(() => buildDxf(drawing, { ...options, scale: 1 }, example)).toThrow(
      "1000 m",
    );
    expect(() =>
      buildDxf(drawing, { ...options, scale: NaN }, example),
    ).toThrow("Check scale");
    expect(() =>
      buildDxf(drawing, { ...options, layers: [] }, example),
    ).toThrow("Select at least");
  });
  it("supports crop and validates crop bounds", () => {
    const data = buildDxf(
      drawing,
      { ...options, crop: { minX: 0, maxX: 4500, minY: 0, maxY: 7000 } },
      example,
    );
    expect(data.openings).toEqual([]);
    expect(() =>
      buildDxf(
        drawing,
        { ...options, crop: { minX: 2, maxX: 1, minY: 0, maxY: 3 } },
        example,
      ),
    ).toThrow("Crop bounds");
  });
  it("parses a real ASCII DXF rectangular wall into a centre line", () => {
    const text = [
      0,
      "SECTION",
      2,
      "ENTITIES",
      0,
      "LWPOLYLINE",
      8,
      "WALLS",
      90,
      4,
      70,
      1,
      10,
      0,
      20,
      0,
      10,
      4000,
      20,
      0,
      10,
      4000,
      20,
      200,
      10,
      0,
      20,
      200,
      0,
      "ENDSEC",
      0,
      "EOF",
    ].join("\n");
    const parsed = parseDxf(text);
    expect(parsed.strokes).toHaveLength(1);
    expect(parsed.strokes[0]!.thickness).toBe(200);
    expect(
      buildDxf(parsed, options, example).building.walls[0]!.thickness,
    ).toBeCloseTo(0.2);
  });
  it("reports unsupported entities, rejects binary and malformed content", () => {
    expect(() => parseDxf("AutoCAD Binary DXF")).toThrow("Binary");
    expect(() => parseDxf("hello")).toThrow();
    expect(dxfScale(4)).toBe(0.001);
    expect(dxfScale(0)).toBeNull();
  });
  it("expands translated, rotated and scaled 2D blocks", () => {
    const text = [
      0,
      "SECTION",
      2,
      "BLOCKS",
      0,
      "BLOCK",
      2,
      "MAIN",
      70,
      0,
      10,
      0,
      20,
      0,
      30,
      0,
      0,
      "LINE",
      8,
      "WALLS",
      10,
      0,
      20,
      0,
      30,
      0,
      11,
      1000,
      21,
      0,
      31,
      0,
      0,
      "ENDBLK",
      0,
      "ENDSEC",
      0,
      "SECTION",
      2,
      "ENTITIES",
      0,
      "INSERT",
      2,
      "MAIN",
      8,
      "0",
      10,
      2000,
      20,
      3000,
      30,
      0,
      41,
      2,
      42,
      2,
      50,
      90,
      0,
      "ENDSEC",
      0,
      "EOF",
    ].join("\n");
    const parsed = parseDxf(text);
    expect(parsed.strokes).toHaveLength(1);
    expect(parsed.strokes[0]!.start.x).toBeCloseTo(2000);
    expect(parsed.strokes[0]!.start.y).toBeCloseTo(3000);
    expect(parsed.strokes[0]!.end.x).toBeCloseTo(2000);
    expect(parsed.strokes[0]!.end.y).toBeCloseTo(5000);
    expect(parsed.strokes[0]!.layer).toContain("MAIN");
  });
  it("prefers a main-plan wall block over a separate section", () => {
    const source = {
      ...drawing,
      strokes: [
        stroke("a", 0, 0, 1, 0, "A-WALL · STORE_MAIN"),
        stroke("b", 10, 0, 11, 0, "A-WALL · STORE_SECTION"),
      ],
    };
    expect(suggestedWallLayers(source)).toEqual(["A-WALL · STORE_MAIN"]);
  });
});
