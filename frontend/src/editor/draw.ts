import type { BuildingScenario, Point } from "../types/simulation";
import { canvasView, openingSegment, type Selection } from "./geometry";
import { drawGrid } from "./drawGrid";
import type { DraftingPreferences } from "./drafting";
import { solidWallSegments, openingLabels } from "./openings";
import { drawFurniture, type FurnitureKind } from "./furniture";
import { dragRectangle, wallShapePoints } from "./shapes";
import { isWallTool, type EditorTool } from "./tools";
import { canvasPalette, type CanvasPalette } from "../styles/canvasPalette";

export function drawLayout(
  canvas: HTMLCanvasElement,
  building: BuildingScenario,
  selected: Selection | readonly Selection[] | null,
  draft?: {
    start: Point;
    end: Point;
    shape: EditorTool | "marquee";
    constrain?: boolean;
    points?: readonly Point[];
  },
  pixelRatio = 1,
  palette: CanvasPalette = canvasPalette(canvas),
  options?: {
    grid?: DraftingPreferences;
    furniture?: ReadonlyMap<string, FurnitureKind>;
  },
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const display = canvas.getBoundingClientRect();
  if (display.width <= 0 || display.height <= 0) return;
  const ratio = Number.isFinite(pixelRatio) ? Math.max(1, pixelRatio) : 1;
  const width = Math.max(1, Math.round(display.width * ratio));
  const height = Math.max(1, Math.round(display.height * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const { scale, x, y } = canvasView(canvas.width, canvas.height, building);
  const px = ratio / scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, x, y);
  ctx.fillStyle = palette.surface;
  ctx.fillRect(0, 0, building.width, building.height);
  if (options?.grid)
    drawGrid(ctx, building, { scale, x, y }, ratio, options.grid, palette);
  ctx.lineCap = "round";
  const selections: readonly Selection[] = selected
    ? Array.isArray(selected)
      ? selected
      : [selected as Selection]
    : [];
  const selectedIds = new Set(selections.map((s) => s.id));
  const single = selections.length === 1 ? selections[0] : null;
  for (const rectangle of [
    ...building.spawn_zones,
    ...building.obstructions,
    ...(building.stair_areas ?? []),
  ]) {
    const spawn = "count" in rectangle;
    const stair = building.stair_areas?.some((a) => a.id === rectangle.id);
    ctx.fillStyle = spawn || stair ? palette.spawn : palette.obstacle;
    ctx.strokeStyle = selectedIds.has(rectangle.id)
      ? palette.selection
      : stair
        ? palette.shelter
        : spawn
          ? palette.spawnBorder
          : palette.obstacleBorder;
    ctx.lineWidth = (selectedIds.has(rectangle.id) ? 2 : 1) * px;
    ctx.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    ctx.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    const furniture = options?.furniture?.get(rectangle.id);
    if (furniture) {
      drawFurniture(ctx, furniture, rectangle, px);
      continue;
    }
    if (!spawn && !stair && palette.blueprint === "1") {
      // Unclassified imported blockers retain an honest technical footprint.
      const inset = Math.min(0.08, rectangle.width / 5, rectangle.height / 5);
      ctx.lineWidth = px;
      ctx.strokeRect(
        rectangle.x + inset,
        rectangle.y + inset,
        rectangle.width - 2 * inset,
        rectangle.height - 2 * inset,
      );
      continue;
    }
    if (stair) {
      const angle =
        "orientation_degrees" in rectangle
          ? (rectangle.orientation_degrees ?? 0)
          : 0;
      const at = (u: number, v: number) => {
        const [a, b] =
          angle === 90
            ? [1 - v, u]
            : angle === 180
              ? [1 - u, 1 - v]
              : angle === 270
                ? [v, 1 - u]
                : [u, v];
        return {
          x: rectangle.x + a! * rectangle.width,
          y: rectangle.y + b! * rectangle.height,
        };
      };
      ctx.strokeStyle = selectedIds.has(rectangle.id)
        ? palette.selection
        : palette.shelter;
      ctx.lineWidth = px;
      ctx.beginPath();
      for (let i = 1; i <= 7; i++) {
        const a = at(0.12, i / 9),
          b = at(0.88, i / 9);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      const arrow = [
        at(0.5, 0.87),
        at(0.5, 0.12),
        at(0.4, 0.24),
        at(0.5, 0.12),
        at(0.6, 0.24),
      ];
      ctx.moveTo(arrow[0]!.x, arrow[0]!.y);
      for (const p of arrow.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      continue;
    }
    ctx.fillStyle = spawn ? palette.wall : palette.obstacleText;
    ctx.font = `${12 * px}px system-ui`;
    ctx.fillText(
      spawn
        ? `${rectangle.count} ${rectangle.count === 1 ? "occupant" : "occupants"}`
        : "Obstruction",
      rectangle.x + 6 * px,
      rectangle.y + 17 * px,
      Math.max(rectangle.width - 8 * px, px),
    );
  }
  for (const wall of building.walls) {
    for (const [start, end] of solidWallSegments(building, wall)) {
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      if (selectedIds.has(wall.id)) {
        ctx.lineWidth = wall.thickness + 6 * px;
        ctx.strokeStyle = palette.selection;
        ctx.stroke();
      }
      ctx.lineWidth = wall.thickness;
      ctx.strokeStyle = palette.wall;
      ctx.stroke();
      if (palette.blueprint === "1" && wall.thickness > 2 * px) {
        ctx.lineWidth = wall.thickness - 2 * px;
        ctx.strokeStyle = palette.surface;
        ctx.stroke();
      }
    }
  }
  for (const [openings, color] of [
    [building.doors, palette.door],
    [building.exits, palette.exit],
  ] as const) {
    for (const opening of openings) {
      const wall = building.walls.find((v) => v.id === opening.wall_id);
      if (!wall) continue;
      const [a, b] = openingSegment(opening, wall);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineCap = "butt";
      ctx.lineWidth = selectedIds.has(opening.id) ? 5 * px : 3 * px;
      ctx.strokeStyle = building.blocked_exit_ids.includes(opening.id)
        ? palette.danger
        : color;
      ctx.stroke();
      if (
        palette.blueprint === "1" &&
        building.doors.some((o) => o.id === opening.id)
      ) {
        const angle = Math.atan2(b.y - a.y, b.x - a.x),
          normal = { x: -Math.sin(angle), y: Math.cos(angle) };
        ctx.lineWidth = px;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(
          a.x + normal.x * opening.width,
          a.y + normal.y * opening.width,
        );
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(a.x, a.y, opening.width, angle, angle + Math.PI / 2);
        ctx.stroke();
      }
      ctx.lineCap = "round";
    }
  }
  ctx.font = `${11 * px}px system-ui`;
  for (const label of openingLabels(
    building,
    px,
    (text) => ctx.measureText?.(text).width ?? text.length * 6 * px,
  )) {
    ctx.fillStyle = building.blocked_exit_ids.includes(label.id)
      ? palette.danger
      : building.exits.some((o) => o.id === label.id)
        ? palette.exit
        : palette.door;
    ctx.fillText(label.text, label.x, label.y);
  }
  if (single?.kind === "walls") {
    const wall = building.walls.find((v) => v.id === single.id);
    if (wall)
      for (const point of [wall.start, wall.end]) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5 * px, 0, Math.PI * 2);
        ctx.fillStyle = palette.surface;
        ctx.strokeStyle = palette.selection;
        ctx.lineWidth = 2 * px;
        ctx.fill();
        ctx.stroke();
      }
  }
  if (draft) {
    ctx.strokeStyle = palette.selection;
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    if (draft.shape === "marquee") {
      const r = dragRectangle(draft.start, draft.end, building);
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = palette.selection;
      ctx.fillRect(r.x, r.y, r.width, r.height);
      ctx.globalAlpha = 1;
      ctx.strokeRect(r.x, r.y, r.width, r.height);
    } else if (draft.shape === "wall-freehand") {
      ctx.setLineDash([]);
      ctx.lineWidth = 0.2;
      ctx.globalAlpha = 0.65;
      if (draft.points?.length) {
        ctx.beginPath();
        ctx.moveTo(draft.points[0]!.x, draft.points[0]!.y);
        for (const p of draft.points.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (isWallTool(draft.shape)) {
      const points = wallShapePoints(
        draft.shape,
        draft.start,
        draft.end,
        building,
        draft.constrain,
      );
      ctx.beginPath();
      ctx.moveTo(points[0]!.x, points[0]!.y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    } else {
      const r = dragRectangle(
        draft.start,
        draft.end,
        building,
        !!draft.constrain,
      );
      ctx.strokeRect(r.x, r.y, r.width, r.height);
    }
    ctx.setLineDash([]);
  }
  ctx.fillStyle = palette.muted;
  ctx.font = `${12 * px}px system-ui`;
  ctx.fillText(`${building.width} × ${building.height} m`, 12 * px, 20 * px);
}
