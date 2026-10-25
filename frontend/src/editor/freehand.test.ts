import { describe, it, expect } from "vitest";
import example from "../../../shared/examples/building.json";
import {
  addFreehandWalls,
  curvePolyline,
  sampleCurve,
  MAX_CURVE_SEGMENTS,
  MAX_CURVE_SAMPLES,
} from "./freehand";
import { buildingError, distance } from "./geometry";
import { moveSelection, removeSelection } from "./selection";
const empty = () => ({
  ...structuredClone(example),
  walls: [],
  doors: [],
  exits: [],
  spawn_zones: [],
  blocked_exit_ids: [],
  obstructions: [],
});
describe("freehand polylines in metres", () => {
  it("smooths and simplifies a densely sampled curve into bounded actual wall segments", () => {
    const raw = Array.from({ length: 500 }, (_, i) => ({
      x: 3 + i / 60,
      y: 5 + 2 * Math.sin((i / 499) * Math.PI) + 0.006 * Math.sin(i * 2),
    }));
    const result = curvePolyline(raw);
    expect(result.error).toBeNull();
    expect(result.points.length).toBeLessThan(40);
    expect(result.points[0]).toEqual(raw[0]);
    expect(result.points.at(-1)).toEqual(raw.at(-1));
    expect(
      result.points
        .slice(1)
        .every((p, i) => distance(p, result.points[i]!) >= 0.1),
    ).toBe(true);
    let n = 0;
    const b = addFreehandWalls(
      empty(),
      result.points,
      () => `curve-${++n}`,
      0.3,
    );
    expect(buildingError(b, false)).toBeNull();
    expect(
      b.walls.every(
        (w, i) =>
          w.thickness === 0.3 &&
          (i === 0 ||
            JSON.stringify(w.start) === JSON.stringify(b.walls[i - 1]!.end)),
      ),
    ).toBe(true);
    expect(b.walls.map((w) => w.start)).toEqual(result.points.slice(0, -1));
  });
  it("preserves deliberate right-angle corners and endpoints", () => {
    const raw = [
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
      { x: 4, y: 3 },
      { x: 4, y: 4 },
      { x: 6, y: 4 },
    ];
    expect(curvePolyline(raw)).toEqual({
      points: [raw[0], raw[2], raw[4], raw[5]],
      error: null,
    });
  });
  it("supports a closed hand-drawn loop without a degenerate closure", () => {
    const raw = Array.from({ length: 101 }, (_, i) => ({
      x: 10 + 3 * Math.cos((i / 100) * 2 * Math.PI),
      y: 10 + 2 * Math.sin((i / 100) * 2 * Math.PI),
    }));
    raw[100] = { ...raw[0]! };
    const result = curvePolyline(raw);
    expect(result.error).toBeNull();
    expect(result.points[0]).toEqual(result.points.at(-1));
    expect(
      buildingError(addFreehandWalls(empty(), result.points), false),
    ).toBeNull();
  });
  it.each(
    [
      [],
      [{ x: 2, y: 2 }],
      [
        { x: 2, y: 2 },
        { x: 2, y: 2 },
      ],
      [
        { x: 2, y: 2 },
        { x: 2.03, y: 2.01 },
      ],
      [
        { x: NaN, y: 2 },
        { x: 3, y: 2 },
      ],
    ].map((raw) => ({ raw })),
  )("rejects degenerate/invalid movement $raw", ({ raw }) => {
    expect(curvePolyline(raw).error).not.toBeNull();
  });
  it("bounds raw samples and rejects excessive corners instead of silently truncating the saved curve", () => {
    let samples = [{ x: 0, y: 0 }];
    samples = sampleCurve(samples, { x: 0.001, y: 0 });
    expect(samples).toHaveLength(1);
    for (let i = 1; i < MAX_CURVE_SAMPLES + 20; i++)
      samples = sampleCurve(samples, { x: i, y: 0 });
    expect(samples).toHaveLength(MAX_CURVE_SAMPLES);
    const zigzag = Array.from({ length: MAX_CURVE_SEGMENTS + 20 }, (_, i) => ({
      x: 2 + i * 0.2,
      y: 4 + (i % 2),
    }));
    expect(curvePolyline(zigzag).error).toMatch(/limit/);
    expect(
      curvePolyline(
        [
          { x: 2, y: 2 },
          { x: 3, y: 3 },
        ],
        0,
      ).error,
    ).toMatch(/limit/);
  });
  it("round-trips ordinary segments without inventing group metadata and supports batch editing", () => {
    let n = 0;
    const result = curvePolyline([
      { x: 3, y: 3 },
      { x: 4, y: 4 },
      { x: 6, y: 4 },
    ]);
    const b = addFreehandWalls(empty(), result.points, () => `c${++n}`),
      imported = JSON.parse(JSON.stringify(b));
    expect(imported).toEqual(b);
    expect(buildingError(imported, false)).toBeNull();
    expect(Object.keys(imported.walls[0]).sort()).toEqual([
      "end",
      "id",
      "name",
      "start",
      "thickness",
    ]);
    const selection = b.walls.map((w) => ({
      kind: "walls" as const,
      id: w.id,
    }));
    const moved = moveSelection(b, selection, { x: 1, y: 1 });
    expect(moved.walls[0]!.start).toEqual({ x: 4, y: 4 });
    expect(removeSelection(moved, selection).walls).toEqual([]);
    expect(b.walls[0]!.start).toEqual({ x: 3, y: 3 });
  });
});
