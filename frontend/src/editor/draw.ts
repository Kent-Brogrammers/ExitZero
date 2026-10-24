import type { BuildingScenario, Point } from "../types/simulation";
import { canvasView, openingSegment, type Selection } from "./geometry";

export function drawLayout(
  canvas: HTMLCanvasElement,
  building: BuildingScenario,
  selected: Selection | null,
  draft?: { start: Point; end: Point; rectangle: boolean },
  pixelRatio = 1,
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
  ctx.fillStyle = "#0a0a10";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, x, y);
  ctx.fillStyle = "#101017";
  ctx.fillRect(0, 0, building.width, building.height);
  ctx.lineCap = "round";
  const selectedId = selected?.id;
  for (const rectangle of [...building.spawn_zones, ...building.obstructions]) {
    const spawn = "count" in rectangle;
    ctx.fillStyle = spawn ? "#1c1c26" : "#25221d";
    ctx.strokeStyle =
      rectangle.id === selectedId ? "#5fa8f7" : spawn ? "#686575" : "#a18c73";
    ctx.lineWidth = (rectangle.id === selectedId ? 2 : 1) * px;
    ctx.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    ctx.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    ctx.fillStyle = spawn ? "#adaab8" : "#d7c2a6";
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
    ctx.moveTo(wall.start.x, wall.start.y);
    ctx.lineTo(wall.end.x, wall.end.y);
    if (wall.id === selectedId) {
      ctx.lineWidth = wall.thickness + 6 * px;
      ctx.strokeStyle = "#5fa8f7";
      ctx.stroke();
    }
    ctx.lineWidth = wall.thickness;
    ctx.strokeStyle = "#adaab8";
    ctx.stroke();
  }
  for (const [kind, openings, color] of [
    ["doors", building.doors, "#c7a66f"],
    ["exits", building.exits, "#38c99b"],
  ] as const) {
    for (const opening of openings) {
      const wall = building.walls.find((v) => v.id === opening.wall_id);
      if (!wall) continue;
      const [a, b] = openingSegment(opening, wall);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = wall.thickness + 2 * px;
      ctx.strokeStyle = "#101017";
      ctx.stroke();
      ctx.lineWidth = opening.id === selectedId ? 5 * px : 3 * px;
      ctx.strokeStyle = building.blocked_exit_ids.includes(opening.id)
        ? "#e39486"
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
        ctx.fillStyle = "#101017";
        ctx.strokeStyle = "#5fa8f7";
        ctx.lineWidth = 2 * px;
        ctx.fill();
        ctx.stroke();
      }
  }
  if (draft) {
    ctx.strokeStyle = "#5fa8f7";
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    if (draft.rectangle)
      ctx.strokeRect(
        draft.start.x,
        draft.start.y,
        draft.end.x - draft.start.x,
        draft.end.y - draft.start.y,
      );
    else {
      ctx.beginPath();
      ctx.moveTo(draft.start.x, draft.start.y);
      ctx.lineTo(draft.end.x, draft.end.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  ctx.fillStyle = "#aaa8b8";
  ctx.font = `${12 * px}px system-ui`;
  ctx.fillText(`${building.width} × ${building.height} m`, 12 * px, 20 * px);
}
