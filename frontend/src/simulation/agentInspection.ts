import { canvasView } from "../editor/geometry";
import type { CanvasPalette } from "../styles/canvasPalette";
import type {
  AgentPosition,
  AnimationFrame,
  BuildingScenario,
  Point,
} from "../types/simulation";
import { canDisplayMovement } from "./interpolation";

export interface AgentTrailPoint {
  step: number;
  position: AgentPosition;
  connect: boolean;
}

/** Matches the existing blue/orange/red occupant display thresholds. */
export function injuryLabel(injury = 0) {
  return injury >= 0.5
    ? "Severely Injured"
    : injury > 0.01
      ? "Injured"
      : "Healthy";
}

/** Samples are observations, never route waypoints or reconstructed physics. */
export function agentTrail(
  building: BuildingScenario,
  frames: readonly AnimationFrame[],
  id: number,
): AgentTrailPoint[] {
  const trail: AgentTrailPoint[] = [];
  let previous: AnimationFrame | undefined;
  for (const frame of frames) {
    const position = frame.agents.find((agent) => agent.id === id);
    const last = trail.at(-1);
    if (position) {
      trail.push({
        step: frame.step,
        position,
        connect: Boolean(
          previous &&
          last &&
          canDisplayMovement(building, previous, last.position, position),
        ),
      });
      previous = frame;
    } else previous = undefined;
  }
  return trail;
}

/** Hit-test the displayed frame in CSS pixels, including the canvas's fit margins. */
export function pickAgent(
  canvas: HTMLCanvasElement,
  building: BuildingScenario,
  frame: AnimationFrame | null,
  client: Point,
  showNumbers: boolean,
): number | null {
  const rect = canvas.getBoundingClientRect();
  if (!frame || rect.width <= 0 || rect.height <= 0) return null;
  const view = canvasView(canvas.width, canvas.height, building);
  const scaleX = rect.width / canvas.width;
  const scaleY = rect.height / canvas.height;
  let closest: number | null = null;
  let best = Infinity;
  const candidates = [
    ...frame.agents,
    ...(frame.pursuit?.caught ?? []).flatMap((caught) =>
      caught.position ? [{ ...caught.position, id: caught.agent_id }] : [],
    ),
  ];
  for (const agent of candidates) {
    const x = rect.left + (view.x + agent.x * view.scale) * scaleX;
    const y = rect.top + (view.y + agent.y * view.scale) * scaleY;
    const distance = Math.hypot(client.x - x, client.y - y);
    const radius = Math.max(
      8,
      building.agent_radius * view.scale * Math.max(scaleX, scaleY),
      showNumbers ? Math.min(14, 7 + String(agent.id + 1).length * 1.5) : 0,
    );
    if (distance <= radius && distance < best) {
      best = distance;
      closest = agent.id;
    }
  }
  return closest;
}

export function drawAgentInspection(
  canvas: HTMLCanvasElement,
  building: BuildingScenario,
  frame: AnimationFrame | null,
  id: number | null,
  trail: readonly AgentTrailPoint[],
  step: number,
  palette: CanvasPalette,
) {
  if (id === null) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const view = canvasView(canvas.width, canvas.height, building);
  const ratio = window.devicePixelRatio || 1;
  const point = (p: Point) => ({
    x: view.x + p.x * view.scale,
    y: view.y + p.y * view.scale,
  });
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = palette.selection;
  ctx.fillStyle = palette.selection;
  ctx.lineWidth = 2 * ratio;
  ctx.setLineDash([5 * ratio, 3 * ratio]);
  ctx.beginPath();
  let last: AgentPosition | undefined;
  for (const sample of trail) {
    if (sample.step > step + 1e-8) break;
    const p = point(sample.position);
    if (sample.connect && last) ctx.lineTo(p.x, p.y);
    else ctx.moveTo(p.x, p.y);
    last = sample.position;
  }
  ctx.stroke();
  ctx.setLineDash([]);
  const current = frame?.agents.find((agent) => agent.id === id);
  const plan = current?.planned_path;
  if (current && plan?.waypoints.length) {
    ctx.strokeStyle = palette.exit;
    ctx.beginPath();
    const start = point(current);
    ctx.moveTo(start.x, start.y);
    for (const waypoint of plan.waypoints) {
      const p = point(waypoint);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    if (!plan.continues) {
      const goal = point(plan.waypoints.at(-1)!);
      ctx.beginPath();
      ctx.arc(goal.x, goal.y, 3 * ratio, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = palette.selection;
  }
  const caught = frame?.pursuit?.caught.find((agent) => agent.agent_id === id);
  const position = current ?? caught?.position ?? last;
  if (position) {
    const p = point(position);
    ctx.beginPath();
    ctx.arc(
      p.x,
      p.y,
      Math.max(building.agent_radius * view.scale, 7 * ratio) + 4 * ratio,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
    ctx.font = `600 ${12 * ratio}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(`Agent ${id + 1}`, p.x, p.y - 14 * ratio);
  }
  ctx.restore();
}
