import type { BuildingScenario, Point } from "../types/simulation";
import { canvasView, openingSegment, type Selection } from "./geometry";
import { dragRectangle, wallShapePoints } from "./shapes";
import { isWallTool, type EditorTool } from "./tools";
import { canvasPalette, type CanvasPalette } from "../styles/canvasPalette";
import { solidWallSegments } from "./wallGeometry";

export function drawLayout(
  canvas: HTMLCanvasElement,
  building: BuildingScenario,
  selected: Selection | null,
  draft?: { start: Point; end: Point; shape: EditorTool },
  pixelRatio = 1,
  palette: CanvasPalette = canvasPalette(canvas),
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
  ctx.lineCap = "butt";
  const selectedId = selected?.id;
  for (const rectangle of [...building.spawn_zones, ...building.obstructions]) {
    const spawn = "count" in rectangle;
    ctx.fillStyle = spawn ? palette.spawn : palette.obstacle;
    ctx.strokeStyle =
      rectangle.id === selectedId
        ? palette.selection
        : spawn
          ? palette.spawnBorder
          : palette.obstacleBorder;
    ctx.lineWidth = (rectangle.id === selectedId ? 2 : 1) * px;
    ctx.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    ctx.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
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
    ctx.beginPath();
    for (const [start, end] of solidWallSegments(building, wall)) {
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
    }
    if (wall.id === selectedId) {
      ctx.lineWidth = wall.thickness + 6 * px;
      ctx.strokeStyle = palette.selection;
      ctx.stroke();
    }
    ctx.lineWidth = wall.thickness;
    ctx.strokeStyle = palette.wall;
    ctx.stroke();
  }
  for (const [kind, openings, color] of [
    ["doors", building.doors, palette.door],
    ["exits", building.exits, palette.exit],
  ] as const) {
    for (const opening of openings) {
      const wall = building.walls.find((v) => v.id === opening.wall_id);
      if (!wall) continue;
      const [a, b] = openingSegment(opening, wall);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = opening.id === selectedId ? 5 * px : 3 * px;
      ctx.strokeStyle = building.blocked_exit_ids.includes(opening.id)
        ? palette.danger
        : color;
      ctx.stroke();
      ctx.font = `${11 * px}px system-ui`;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(
        `${kind === "exits" ? "Exit" : "Door"} · ${opening.width.toFixed(1)} m`,
        (a.x + b.x) / 2 + 7 * px,
        (a.y + b.y) / 2 - 7 * px,
      );
    }
  }
  if (selected?.kind === "walls") {
    const wall = building.walls.find((v) => v.id === selected.id);
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
    if (isWallTool(draft.shape)) {
      const points = wallShapePoints(
        draft.shape,
        draft.start,
        draft.end,
        building,
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
        draft.shape === "object-square",
      );
      ctx.strokeRect(r.x, r.y, r.width, r.height);
    }
    ctx.setLineDash([]);
  }
  ctx.fillStyle = palette.muted;
  ctx.font = `${12 * px}px system-ui`;
  ctx.fillText(`${building.width} × ${building.height} m`, 12 * px, 20 * px);
}
