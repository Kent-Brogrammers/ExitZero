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
  drawAgents(canvas, building, frame, pixelRatio);
}

function drawAgents(
  canvas: HTMLCanvasElement,
  building: BuildingScenario,
  frame: AnimationFrame | null,
  pixelRatio: number,
) {
  const context = canvas.getContext("2d");
  const display = canvas.getBoundingClientRect();
  if (!context || !frame || display.width <= 0 || display.height <= 0) return;
  const view = canvasView(canvas.width, canvas.height, building);
  const ratio = Number.isFinite(pixelRatio) ? Math.max(1, pixelRatio) : 1;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = "#5fa8f7";
  context.strokeStyle = "#0a0a10";
  context.lineWidth = ratio;
  context.beginPath();
  for (const agent of frame.agents) {
    const point = worldToCanvas(agent, view);
    context.moveTo(point.x + building.agent_radius * view.scale, point.y);
    context.arc(
      point.x,
      point.y,
      building.agent_radius * view.scale,
      0,
      Math.PI * 2,
    );
  }
  context.fill();
  context.stroke();
  context.restore();
}

/** Cache the static floor plan; animation redraws only the occupant circles. */
export function createPlaybackRenderer(
  canvas: HTMLCanvasElement,
  building: BuildingScenario,
  layout = canvas.ownerDocument.createElement("canvas"),
) {
  let width = 0,
    height = 0,
    ratio = 0;
  return (frame: AnimationFrame | null, pixelRatio: number) => {
    const display = canvas.getBoundingClientRect();
    if (display.width <= 0 || display.height <= 0) return;
    const nextRatio = Number.isFinite(pixelRatio) ? Math.max(1, pixelRatio) : 1;
    const nextWidth = Math.round(display.width * nextRatio),
      nextHeight = Math.round(display.height * nextRatio);
    const context = canvas.getContext("2d"),
      cache = layout.getContext("2d");
    if (!context || !cache) {
      drawPlayback(canvas, building, frame, nextRatio);
      return;
    }
    if (width !== nextWidth || height !== nextHeight || ratio !== nextRatio) {
      drawLayout(canvas, building, null, undefined, nextRatio);
      width = canvas.width;
      height = canvas.height;
      ratio = nextRatio;
      layout.width = width;
      layout.height = height;
      cache.drawImage(canvas, 0, 0);
    } else {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      context.drawImage(layout, 0, 0);
    }
    drawAgents(canvas, building, frame, nextRatio);
  };
}
