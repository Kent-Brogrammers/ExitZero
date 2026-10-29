import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import DxfParser from "dxf-parser";
import {
  parseDxf,
  buildDxf,
  applyOpenings,
  dxfScale,
  suggestedWallLayers,
  suggestedSolidWalls,
  type DxfDrawing,
} from "./convert";
import example from "../../../../shared/examples/building.json";
import { buildingError } from "../geometry";
import { classifyOpenings } from "./classify";
const classroomDxf = readFileSync(
  new URL("./fixtures/classroom-and-resource-store-70-m2.dxf", import.meta.url),
  "utf8",
);
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
function rectangleDxf(width: number, height: number) {
  return [
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
    width,
    20,
    0,
    10,
    width,
    20,
    height,
    10,
    0,
    20,
    height,
    0,
    "ENDSEC",
    0,
    "EOF",
  ].join("\n");
}
describe("assisted DXF import", () => {
  it.each([1, 0.001])(
    "converts explicitly selected wall solids at scale %s",
    (scale) => {
      const parsed = parseDxf(rectangleDxf(4 / scale, 0.2 / scale));
      const { building } = buildDxf(
        parsed,
        { ...options, scale, closedRectanglesAreWalls: true },
        example,
      );
      expect(building.walls).toHaveLength(1);
      expect(building.walls[0]!.thickness).toBeCloseTo(0.2);
      expect(
        Math.hypot(
          building.walls[0]!.end.x - building.walls[0]!.start.x,
          building.walls[0]!.end.y - building.walls[0]!.start.y,
        ),
      ).toBeCloseTo(4);
      expect(building.width).toBeCloseTo(6);
      expect(building.height).toBeCloseTo(2.2);
      expect(buildingError(building, false)).toBeNull();
    },
  );
  it("rejects oversized wall solids and never reconstructs cropped-out rectangle edges", () => {
    expect(() =>
      buildDxf(
        parseDxf(rectangleDxf(10, 6)),
        { ...options, scale: 1, closedRectanglesAreWalls: true },
        example,
      ),
    ).toThrow("thickness exceeds 6.56 ft");
    const { building } = buildDxf(
      parseDxf(rectangleDxf(4, 0.2)),
      {
        ...options,
        scale: 1,
        closedRectanglesAreWalls: true,
        crop: { minX: -0.1, maxX: 2, minY: -0.1, maxY: 0.3 },
      },
      example,
    );
    expect(building.walls).toHaveLength(1);
    expect(building.walls[0]!.start.x).toBe(building.walls[0]!.end.x);
    expect(buildingError(building, false)).toBeNull();
  });
  it.each([
    [10, 6],
    [8, 2],
    [10, 0.5],
  ])(
    "preserves a %s by %s metre room outline and its scale",
    (width, height) => {
      for (const scale of [1, 0.001]) {
        const parsed = parseDxf(rectangleDxf(width / scale, height / scale));
        const { building } = buildDxf(parsed, { ...options, scale }, example);
        expect(building.walls).toHaveLength(4);
        expect(building.walls.every((wall) => wall.thickness === 0.2)).toBe(
          true,
        );
        expect(building.width).toBeCloseTo(width + 2);
        expect(building.height).toBeCloseTo(height + 2);
        expect(buildingError(building, false)).toBeNull();
      }
    },
  );
  it("clears inherited hazards and shelters while preserving run settings and the original layout", () => {
    const base = {
      ...structuredClone(example),
      disaster: { kind: "fire" as const, center: { x: 25, y: 15 }, radius: 1 },
      tornado_zones: [{ id: "old-shelter", x: 20, y: 12, width: 3, height: 3 }],
      placed_occupants: [{ id: "old-person", x: 25, y: 15 }],
      pursuit: {
        stalker_start: { x: 20, y: 12 },
        stalker_speed: 1,
        survivor_speed: 1,
        capture_radius: 0.4,
        avoidance_radius: 2,
      },
      window_escape_context: {
        floor_elevation_metres: 4,
        all_agents_can_traverse: false,
        required_clear_height_metres: 1,
      },
    };
    const before = structuredClone(base);
    const { building } = buildDxf(
      parseDxf(rectangleDxf(5, 3)),
      { ...options, scale: 1 },
      base,
    );
    expect(building.disaster).toBeUndefined();
    expect(building.tornado_zones).toEqual([]);
    expect(building.placed_occupants).toEqual([]);
    expect(building.pursuit).toBeUndefined();
    expect(building.window_escape_context).toBeUndefined();
    expect(building.seed).toBe(base.seed);
    expect(building.time_step_seconds).toBe(base.time_step_seconds);
    expect(buildingError(building, false)).toBeNull();
    expect(base).toEqual(before);
  });
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
      "3280.8 ft",
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
    expect(parsed.strokes).toHaveLength(4);
    expect(parsed.rectangles![0]!.centerline.thickness).toBe(200);
    expect(
      buildDxf(parsed, { ...options, closedRectanglesAreWalls: true }, example)
        .building.walls[0]!.thickness,
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

  it("imports the classroom wall footprints, short end and all actual openings at millimetre scale", () => {
    const parsed = parseDxf(classroomDxf);
    const layers = suggestedWallLayers(parsed);
    expect(layers).toEqual(["WALLS"]);
    expect(dxfScale(parsed.units)).toBe(0.001);
    expect(suggestedSolidWalls(parsed, layers, dxfScale(parsed.units))).toBe(
      true,
    );
    const settings = {
      ...options,
      layers,
      closedRectanglesAreWalls: true,
    };
    const { building, openings } = buildDxf(parsed, settings, example);
    const guesses = classifyOpenings(parsed, settings, building, openings);
    const reviewed = applyOpenings(
      building,
      openings,
      Object.fromEntries(
        Object.entries(guesses).map(([id, g]) => [id, g.role]),
      ),
    );
    expect([reviewed.width, reviewed.height]).toEqual([12, 9]);
    expect(reviewed.walls).toHaveLength(7);
    expect(
      reviewed.walls.filter((w) => Math.abs(w.thickness - 0.2) < 1e-8),
    ).toHaveLength(4);
    expect(
      reviewed.walls.filter((w) => Math.abs(w.thickness - 0.12) < 1e-8),
    ).toHaveLength(3);
    expect(openings).toHaveLength(9);
    expect(reviewed.doors).toHaveLength(3);
    for (const door of reviewed.doors) expect(door.width).toBeCloseTo(0.9);
    expect(reviewed.exits).toHaveLength(1);
    expect(reviewed.exits[0]!.width).toBeCloseTo(1);
    expect(reviewed.windows).toHaveLength(5);
    expect(
      reviewed.windows!.map((w) => Number(w.width.toFixed(3))).sort(),
    ).toEqual([1.3, 1.5, 1.5, 1.5, 1.5]);
    for (const window of reviewed.windows!) {
      expect(window.emergency_escape?.enabled).toBe(false);
      expect(window.emergency_escape?.exterior_available).toBe(false);
    }
    expect(buildingError(reviewed, false)).toBeNull();
  });

  it.each([0, 90, 37])(
    "keeps square wall ends aligned at %s degrees regardless of vertex order",
    (degrees) => {
      const doc = new DxfParser().parseSync(classroomDxf)!;
      for (const shift of [0, 1, 2, 3]) {
        const angle = (degrees * Math.PI) / 180;
        const entities = doc.entities
          .filter((e) => e.layer === "WALLS")
          .flatMap((entity) => {
            const vertices = (
              entity as typeof entity & { vertices: { x: number; y: number }[] }
            ).vertices;
            const reordered = [
              ...vertices.slice(shift),
              ...vertices.slice(0, shift),
            ];
            return [
              0,
              "LWPOLYLINE",
              8,
              "WALLS",
              90,
              4,
              70,
              1,
              ...reordered.flatMap(({ x, y }) => [
                10,
                x * Math.cos(angle) - y * Math.sin(angle),
                20,
                x * Math.sin(angle) + y * Math.cos(angle),
              ]),
            ];
          });
        const text = [
          0,
          "SECTION",
          2,
          "ENTITIES",
          ...entities,
          0,
          "ENDSEC",
          0,
          "EOF",
        ].join("\n");
        const { building, openings } = buildDxf(
          parseDxf(text),
          { ...options, closedRectanglesAreWalls: true },
          example,
        );
        expect(building.walls, `vertex shift ${shift}`).toHaveLength(7);
        expect(openings, `vertex shift ${shift}`).toHaveLength(9);
        expect(buildingError(building, false)).toBeNull();
      }
    },
  );

  it("leaves room outlines and unknown units for explicit review, and respects the solid-wall override", () => {
    for (const [width, height] of [
      [10, 6],
      [10, 0.5],
      [0.2, 0.2],
    ] as const) {
      const parsed = parseDxf(rectangleDxf(width, height));
      expect(suggestedSolidWalls(parsed, ["WALLS"], 1)).toBe(false);
    }
    const parsed = parseDxf(classroomDxf);
    expect(suggestedSolidWalls(parsed, ["WALLS"], null)).toBe(false);
    expect(suggestedSolidWalls(parsed, ["FIXTURES"], 0.001)).toBe(false);
    expect(
      buildDxf(parsed, { ...options, closedRectanglesAreWalls: false }, example)
        .building.walls.length,
    ).toBeGreaterThan(7);
    const square = buildDxf(
      parseDxf(rectangleDxf(0.2, 0.2)),
      { ...options, scale: 1, closedRectanglesAreWalls: true },
      example,
    );
    expect(square.building.walls).toHaveLength(4);
  });
});
