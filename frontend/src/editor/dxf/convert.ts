import DxfParser from "dxf-parser";
import type { Point, BuildingScenario, Wall } from "../../types/simulation";

export interface DxfStroke {
  id: string;
  layer: string;
  start: Point;
  end: Point;
  thickness: number | null;
}
export interface DxfDrawing {
  strokes: DxfStroke[];
  units: number;
  warnings: string[];
}
export interface OpeningCandidate {
  id: string;
  wall_id: string;
  offset: number;
  width: number;
}
export type OpeningChoice = "review" | "door" | "exit" | "closed";
export interface ImportOptions {
  layers: string[];
  scale: number;
  thickness: number;
  maxGap: number;
  crop?: { minX: number; maxX: number; minY: number; maxY: number };
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export function parseDxf(text: string): DxfDrawing {
  if (text.length > 5_000_000)
    throw new Error("DXF must be smaller than 5 MB.");
  if (text.startsWith("AutoCAD Binary DXF"))
    throw new Error("Binary DXF is unsupported. Export an ASCII DXF.");
  const doc = new DxfParser().parseSync(text);
  if (!doc?.entities?.length)
    throw new Error("No model-space geometry found in this DXF.");
  if (doc.entities.length > 20_000)
    throw new Error(
      "Drawing exceeds 20,000 entities. Export just the floor plan.",
    );
  const strokes: DxfStroke[] = [],
    skipped = new Map<string, number>();
  const skip = (type: string) =>
    skipped.set(type, (skipped.get(type) ?? 0) + 1);
  type Raw = (typeof doc.entities)[number] & {
    vertices?: (Point & { z?: number; bulge?: number })[];
    name?: string;
    position?: Point & { z?: number };
    rotation?: number;
    xScale?: number;
    yScale?: number;
    rowCount?: number;
    columnCount?: number;
    extrusionDirection?: { z?: number };
  };
  type Matrix = [number, number, number, number, number, number];
  const expanded: Raw[] = [];
  const mapPoint = (p: Point, m: Matrix) => ({
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
  });
  const compose = (p: Matrix, c: Matrix): Matrix => [
    p[0] * c[0] + p[2] * c[1],
    p[1] * c[0] + p[3] * c[1],
    p[0] * c[2] + p[2] * c[3],
    p[1] * c[2] + p[3] * c[3],
    p[0] * c[4] + p[2] * c[5] + p[4],
    p[1] * c[4] + p[3] * c[5] + p[5],
  ];
  function expand(e: Raw, matrix: Matrix, inherited: string, path: string[]) {
    if (e.inPaperSpace || e.visible === false) {
      skip("hidden/paper-space");
      return;
    }
    const layer = e.layer && e.layer !== "0" ? e.layer : inherited || "0";
    if (e.type === "INSERT") {
      const name = e.name ?? "";
      const block = doc!.blocks?.[name];
      if (path.includes(name) || path.length >= 8)
        throw new Error(
          "Recursive or excessively nested DXF blocks. Explode the floor-plan block before importing.",
        );
      if (!block?.entities) {
        skip("unresolved block");
        return;
      }
      if (
        (e.rowCount ?? 1) > 1 ||
        (e.columnCount ?? 1) > 1 ||
        (e.position?.z ?? 0) !== 0 ||
        (e.extrusionDirection?.z ?? 1) !== 1
      ) {
        skip("array/3D block");
        return;
      }
      const angle = ((e.rotation ?? 0) * Math.PI) / 180,
        sx = e.xScale ?? 1,
        sy = e.yScale ?? 1;
      if (![angle, sx, sy].every(Number.isFinite) || sx === 0 || sy === 0)
        throw new Error("Invalid DXF block transform.");
      const a = Math.cos(angle) * sx,
        b = Math.sin(angle) * sx,
        c = -Math.sin(angle) * sy,
        d = Math.cos(angle) * sy;
      const origin = block.position ?? { x: 0, y: 0 };
      const local: Matrix = [
        a,
        b,
        c,
        d,
        (e.position?.x ?? 0) - a * origin.x - c * origin.y,
        (e.position?.y ?? 0) - b * origin.x - d * origin.y,
      ];
      for (const child of block.entities)
        expand(child as Raw, compose(matrix, local), layer, [...path, name]);
      return;
    }
    expanded.push({
      ...e,
      layer: layer + (path.length ? ` · ${path.join("/")}` : ""),
      ...(e.vertices
        ? {
            vertices: e.vertices.map((v) => ({ ...v, ...mapPoint(v, matrix) })),
          }
        : {}),
    });
    if (expanded.length > 20000)
      throw new Error(
        "Expanded drawing exceeds 20,000 entities. Export just the plan.",
      );
  }
  for (const entity of doc.entities)
    expand(entity as Raw, [1, 0, 0, 1, 0, 0], "0", []);
  const add = (
    layer: string,
    start: Point,
    end: Point,
    thickness: number | null = null,
  ) => {
    if (![start.x, start.y, end.x, end.y].every(Number.isFinite))
      throw new Error("DXF contains non-finite coordinates.");
    if (distance(start, end) <= 1e-8) return;
    strokes.push({
      id: `entity-${strokes.length}`,
      layer,
      start,
      end,
      thickness,
    });
    if (strokes.length > 20_000)
      throw new Error("Too many segments. Export only the plan region.");
  };
  for (const entity of expanded) {
    if (entity.inPaperSpace || entity.visible === false) {
      skip("hidden/paper-space");
      continue;
    }
    const e = entity as typeof entity & {
      vertices?: (Point & { z?: number; bulge?: number })[];
      shape?: boolean;
      is3dPolyline?: boolean;
      elevation?: number;
      extrusionDirectionZ?: number;
      extrusionDirection?: { z?: number };
    };
    if (!["LINE", "LWPOLYLINE", "POLYLINE"].includes(e.type) || !e.vertices) {
      skip(e.type);
      continue;
    }
    if (
      e.is3dPolyline ||
      (e.elevation ?? 0) !== 0 ||
      (e.extrusionDirectionZ ?? e.extrusionDirection?.z ?? 1) !== 1 ||
      e.vertices.some((v) => (v.z ?? 0) !== 0 || (v.bulge ?? 0) !== 0)
    ) {
      skip("curved/3D geometry");
      continue;
    }
    const points = e.vertices.map((v) => ({ x: v.x, y: v.y }));
    if (points.length > 2 && distance(points[0]!, points.at(-1)!) < 1e-8)
      points.pop();
    // Narrow closed rectangles are wall solids: replace outlines with one centre line.
    if (e.shape && points.length === 4) {
      const [a, b, c, d] = points as [Point, Point, Point, Point];
      const lengths = [
        distance(a, b),
        distance(b, c),
        distance(c, d),
        distance(d, a),
      ];
      const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
      const rectangular =
        Math.abs(dot) < 1e-5 * lengths[0]! * lengths[1]! &&
        Math.abs(lengths[0]! - lengths[2]!) < 1e-5 * lengths[0]! &&
        Math.abs(lengths[1]! - lengths[3]!) < 1e-5 * lengths[1]!;
      if (
        rectangular &&
        Math.max(lengths[0]!, lengths[1]!) >
          Math.min(lengths[0]!, lengths[1]!) * 1.2
      ) {
        const mid = (p: Point, q: Point) => ({
          x: (p.x + q.x) / 2,
          y: (p.y + q.y) / 2,
        });
        if (lengths[0]! >= lengths[1]!)
          add(e.layer, mid(a, d), mid(b, c), lengths[1]!);
        else add(e.layer, mid(a, b), mid(c, d), lengths[0]!);
        continue;
      }
    }
    for (let i = 1; i < points.length; i++)
      add(e.layer, points[i - 1]!, points[i]!);
    if (e.shape && points.length > 2) add(e.layer, points.at(-1)!, points[0]!);
  }
  if (!strokes.length)
    throw new Error(
      "No supported straight LINE or POLYLINE geometry. Explode blocks and export a 2D ASCII DXF.",
    );
  return {
    strokes,
    units: Number(doc.header?.["$INSUNITS"] ?? 0),
    warnings: [...skipped].map(
      ([type, count]) =>
        `${count} ${type} entities omitted (annotations, blocks, curves or unsupported geometry).`,
    ),
  };
}

export function suggestedWallLayers(drawing: DxfDrawing): string[] {
  const layers = [...new Set(drawing.strokes.map((s) => s.layer))].filter(
    (name) => /wall|partition|mur|pared/i.test(name),
  );
  const main = layers.filter((name) => /\bMAIN\b|_MAIN\b/i.test(name));
  return main.length ? main : layers;
}

export function dxfScale(units: number): number | null {
  return (
    (
      { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1, 7: 1000 } as Record<
        number,
        number
      >
    )[units] ?? null
  );
}
export function buildDxf(
  drawing: DxfDrawing,
  options: ImportOptions,
  base: BuildingScenario,
): {
  building: BuildingScenario;
  openings: OpeningCandidate[];
  warnings: string[];
} {
  if (
    !Number.isFinite(options.scale) ||
    options.scale <= 0 ||
    !Number.isFinite(options.thickness) ||
    options.thickness <= 0 ||
    options.thickness > 2 ||
    !Number.isFinite(options.maxGap) ||
    options.maxGap < 0 ||
    options.maxGap > 5
  )
    throw new Error(
      "Check scale, wall thickness (0–2 m), and maximum gap (0–5 m).",
    );
  if (
    options.crop &&
    (![
      options.crop.minX,
      options.crop.maxX,
      options.crop.minY,
      options.crop.maxY,
    ].every(Number.isFinite) ||
      options.crop.minX >= options.crop.maxX ||
      options.crop.minY >= options.crop.maxY)
  )
    throw new Error(
      "Crop bounds must be finite and minimum must be below maximum.",
    );
  const selected = drawing.strokes
    .filter((s) => options.layers.includes(s.layer))
    .filter(
      (s) =>
        !options.crop ||
        [s.start, s.end].every(
          (p) =>
            p.x >= options.crop!.minX &&
            p.x <= options.crop!.maxX &&
            p.y >= options.crop!.minY &&
            p.y <= options.crop!.maxY,
        ),
    );
  if (!selected.length)
    throw new Error(
      "Select at least one layer containing wall segments inside the crop.",
    );
  if (selected.length > 2000)
    throw new Error(
      "Select fewer layers or crop to at most 2,000 source wall segments.",
    );
  const minX = Math.min(...selected.flatMap((s) => [s.start.x, s.end.x])),
    maxX = Math.max(...selected.flatMap((s) => [s.start.x, s.end.x]));
  const minY = Math.min(...selected.flatMap((s) => [s.start.y, s.end.y])),
    maxY = Math.max(...selected.flatMap((s) => [s.start.y, s.end.y]));
  const width = (maxX - minX) * options.scale + 2,
    height = (maxY - minY) * options.scale + 2;
  if (width > 1000 || height > 1000)
    throw new Error(
      "Imported extent exceeds 1000 m. Check units or crop to the floor plan.",
    );
  const world = (p: Point) => ({
    x: (p.x - minX) * options.scale + 1,
    y: (maxY - p.y) * options.scale + 1,
  });
  type Group = {
    ux: number;
    uy: number;
    normal: number;
    thickness: number;
    intervals: [number, number][];
  };
  const groups: Group[] = [],
    seen = new Set<string>();
  let discarded = 0;
  for (const stroke of selected) {
    let a = world(stroke.start),
      b = world(stroke.end);
    if (a.x > b.x || (a.x === b.x && a.y > b.y)) [a, b] = [b, a];
    const length = distance(a, b);
    if (length < 0.1) {
      discarded++;
      continue;
    }
    const thickness =
      stroke.thickness === null
        ? options.thickness
        : stroke.thickness * options.scale;
    if (thickness <= 0 || thickness > 2)
      throw new Error(
        "Detected wall thickness exceeds 2 m. Exclude non-wall layers or check units.",
      );
    const key = [a.x, a.y, b.x, b.y, thickness]
      .map((v) => v.toFixed(4))
      .join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    const ux = (b.x - a.x) / length,
      uy = (b.y - a.y) / length,
      normal = -uy * a.x + ux * a.y;
    let group = groups.find(
      (g) =>
        Math.abs(g.ux - ux) < 1e-5 &&
        Math.abs(g.uy - uy) < 1e-5 &&
        Math.abs(g.normal - normal) < 0.015 &&
        Math.abs(g.thickness - thickness) < 0.015,
    );
    if (!group) {
      group = { ux, uy, normal, thickness, intervals: [] };
      groups.push(group);
    }
    group.intervals.push([ux * a.x + uy * a.y, ux * b.x + uy * b.y]);
  }
  const walls: Wall[] = [],
    openings: OpeningCandidate[] = [];
  for (const group of groups) {
    const sorted = group.intervals.sort((a, b) => a[0] - b[0]);
    let start = sorted[0]![0],
      end = sorted[0]![1],
      gaps: [number, number][] = [];
    const emit = () => {
      const id = `dxf-wall-${walls.length + 1}`;
      const at = (t: number) => ({
        x: group.ux * t - group.uy * group.normal,
        y: group.uy * t + group.ux * group.normal,
      });
      walls.push({
        id,
        start: at(start),
        end: at(end),
        thickness: group.thickness,
      });
      for (const [a, b] of gaps)
        openings.push({
          id: `dxf-opening-${openings.length + 1}`,
          wall_id: id,
          offset: a - start,
          width: b - a,
        });
    };
    for (const interval of sorted.slice(1)) {
      const gap = interval[0] - end;
      if (gap > options.maxGap) {
        emit();
        start = interval[0];
        end = interval[1];
        gaps = [];
      } else {
        if (gap > 0.1) gaps.push([end, interval[0]]);
        end = Math.max(end, interval[1]);
      }
    }
    emit();
  }
  if (!walls.length || walls.length > 500)
    throw new Error(
      "Import must contain 1–500 walls. Narrow the layer selection or crop.",
    );
  const building: BuildingScenario = {
    ...base,
    width,
    height,
    walls,
    doors: [],
    exits: [],
    spawn_zones: [],
    blocked_exit_ids: [],
    obstructions: [],
    stair_areas: [],
  };
  return {
    building,
    openings,
    warnings: [
      ...drawing.warnings,
      ...(discarded
        ? [`${discarded} segments shorter than 0.1 m omitted.`]
        : []),
      "Wall rectangles become centre lines. Gaps up to the chosen limit are opening suggestions, not verified doors or exits.",
    ],
  };
}
export function applyOpenings(
  building: BuildingScenario,
  candidates: OpeningCandidate[],
  choices: Record<string, OpeningChoice>,
  preview = false,
): BuildingScenario {
  const next = {
    ...building,
    doors: [] as OpeningCandidate[],
    exits: [] as OpeningCandidate[],
  };
  for (const opening of candidates) {
    const choice = choices[opening.id] ?? "review";
    if (choice === "review" && !preview)
      throw new Error("Review every suggested opening before importing.");
    if (choice === "exit") next.exits.push(opening);
    else if (choice === "door" || (choice === "review" && preview))
      next.doors.push(opening);
  }
  return next;
}
