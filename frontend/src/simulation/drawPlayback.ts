import { drawLayout } from "../editor/draw";
import { canvasView } from "../editor/geometry";
import type {
  AnimationFrame,
  BuildingScenario,
  Point,
} from "../types/simulation";

export function worldToCanvas(
  point: Point,
  view: { scale: number; x: number; y: number },
): Point {
  return { x: view.x + point.x * view.scale, y: view.y + point.y * view.scale };
}

export function drawPlayback(
  canvas: HTMLCanvasElement,
  building: BuildingScenario,
  frame: AnimationFrame | null,
  pixelRatio: number,
) {
  drawLayout(canvas, building, null, undefined, pixelRatio);
  const context = canvas.getContext("2d");
  const display = canvas.getBoundingClientRect();
  if (!context || !frame || display.width <= 0 || display.height <= 0) return;
  const view = canvasView(canvas.width, canvas.height, building);
  const ratio = Number.isFinite(pixelRatio) ? Math.max(1, pixelRatio) : 1;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = "#5fa8f7";
  context.strokeStyle = "#17191e";
  context.lineWidth = ratio;
  for (const agent of frame.agents) {
    const point = worldToCanvas(agent, view);
    context.beginPath();
    context.arc(
      point.x,
      point.y,
      building.agent_radius * view.scale,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.stroke();
  }
  context.restore();
}
