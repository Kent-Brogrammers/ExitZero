import { drawLayout } from "../editor/draw";
import { frameLayout } from "./frameLayout";
import { canvasPalette, type CanvasPalette } from "../styles/canvasPalette";
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
  palette: CanvasPalette = canvasPalette(canvas),
) {
  drawLayout(
    canvas,
    frameLayout(building, frame),
    null,
    undefined,
    pixelRatio,
    palette,
    {
      windowStates: frame?.window_states,
      disasterState: frame?.disaster_state,
    },
  );
  drawAgents(canvas, building, frame, pixelRatio, palette);
}

export function drawAgents(
  canvas: HTMLCanvasElement,
  building: BuildingScenario,
  frame: AnimationFrame | null,
  pixelRatio: number,
  palette: CanvasPalette,
) {
  const context = canvas.getContext("2d");
  const display = canvas.getBoundingClientRect();
  if (!context || !frame || display.width <= 0 || display.height <= 0) return;
  const view = canvasView(canvas.width, canvas.height, building);
  const ratio = Number.isFinite(pixelRatio) ? Math.max(1, pixelRatio) : 1;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = palette.selection;
  context.strokeStyle = palette.background;
  context.lineWidth = ratio;
  const groups = [
    {
      color: palette.selection,
      agents: frame.agents.filter((a) => !(a.injury && a.injury > 0.01)),
    },
    {
      color: "#f6a54c",
      agents: frame.agents.filter(
        (a) => (a.injury ?? 0) > 0.01 && (a.injury ?? 0) < 0.5,
      ),
    },
    {
      color: "#ef5b65",
      agents: frame.agents.filter((a) => (a.injury ?? 0) >= 0.5),
    },
  ];
  for (const group of groups) {
    if (!group.agents.length) continue;
    context.fillStyle = group.color;
    context.beginPath();
    for (const agent of group.agents) {
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
  }
  // Queue membership is recorded by Rust, never inferred from proximity or missing IDs.
  const waiting = new Set(
    frame.window_states?.flatMap((s) => s.queue_agent_ids),
  );
  const traversing = new Set(
    frame.window_states?.map((s) => s.traversing_agent_id),
  );
  for (const agent of frame.agents) {
    if (!waiting.has(agent.id) && !traversing.has(agent.id)) continue;
    const p = worldToCanvas(agent, view);
    context.beginPath();
    context.arc(
      p.x,
      p.y,
      building.agent_radius * view.scale + 2 * ratio,
      0,
      Math.PI * 2,
    );
    context.strokeStyle = traversing.has(agent.id)
      ? palette.exit
      : palette.door;
    context.stroke();
  }
  context.restore();
}

/** Cache the static floor plan; animation redraws only the occupant circles. */
export function createPlaybackRenderer(
  canvas: HTMLCanvasElement,
  building: BuildingScenario,
  layout = canvas.ownerDocument.createElement("canvas"),
) {
  const palette = canvasPalette(canvas);
  let openingState: string | undefined;
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
      drawPlayback(canvas, building, frame, nextRatio, palette);
      return;
    }
    const nextOpeningState = JSON.stringify([
      frame?.blocked_opening_ids,
      frame?.window_states?.map((s) => [s.window_id, s.state]),
      frame?.disaster_state,
    ]);
    if (
      width !== nextWidth ||
      height !== nextHeight ||
      ratio !== nextRatio ||
      openingState !== nextOpeningState
    ) {
      openingState = nextOpeningState;
      drawLayout(
        canvas,
        frameLayout(building, frame),
        null,
        undefined,
        nextRatio,
        palette,
        {
          windowStates: frame?.window_states,
          disasterState: frame?.disaster_state,
        },
      );
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
    drawAgents(canvas, building, frame, nextRatio, palette);
  };
}
