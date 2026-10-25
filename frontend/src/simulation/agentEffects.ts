import type {
  AnimationFrame,
  BuildingScenario,
  ChatEvent,
} from "../types/simulation";
import { canvasView } from "../editor/geometry";

type Effect = { kind: "hurt" | "discovery" | "communication"; step: number };
const DURATION = 1.2;

/** Effects follow simulation time, so pausing and rewinding remain deterministic. */
export function createAgentEffects(events: readonly ChatEvent[]) {
  const timeline = [...events].sort((a, b) => a.step - b.step);
  return (
    canvas: HTMLCanvasElement,
    building: BuildingScenario,
    frame: AnimationFrame | null,
    seconds: number,
    ratio: number,
  ) => {
    if (!frame?.agents.length) return;
    const effects = new Map<number, Effect>();
    const firstStep = (seconds - DURATION) / building.time_step_seconds;
    let low = 0,
      high = timeline.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (timeline[middle]!.step < firstStep) low = middle + 1;
      else high = middle;
    }
    const put = (id: number, effect: Effect) => {
      const previous = effects.get(id);
      if (
        !previous ||
        effect.kind === "hurt" ||
        (previous.kind !== "hurt" && effect.kind === "discovery") ||
        previous.kind === effect.kind
      )
        effects.set(id, effect);
    };
    for (let i = low; i < timeline.length; i++) {
      const event = timeline[i]!;
      if (event.step * building.time_step_seconds > seconds + 1e-8) break;
      if ("kind" in event) {
        if (event.kind === "exposure")
          put(event.agent_id, { kind: "hurt", step: event.step });
        else if (
          event.kind === "hazard_discovered" ||
          event.kind === "hazard_spreading"
        )
          put(event.agent_id, { kind: "discovery", step: event.step });
      } else {
        put(event.sender_id, {
          kind:
            event.event_type === "discovery" ? "discovery" : "communication",
          step: event.step,
        });
        for (const id of event.recipient_ids)
          put(id, { kind: "communication", step: event.step });
      }
    }
    if (
      !effects.size &&
      !frame.agents.some((agent) => (agent.injury ?? 0) > 0.01)
    )
      return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const view = canvasView(canvas.width, canvas.height, building);
    const reducedMotion = canvas.ownerDocument.defaultView?.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const radius = Math.max(building.agent_radius * view.scale, 4 * ratio);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = 1.5 * ratio;
    for (const agent of frame.agents) {
      const x = view.x + agent.x * view.scale,
        y = view.y + agent.y * view.scale;
      // A soft red halo remains visible for injured occupants, including legacy recordings.
      if ((agent.injury ?? 0) > 0.01) {
        ctx.globalAlpha = reducedMotion
          ? 0.2
          : 0.17 + 0.09 * Math.sin(seconds * 5 + agent.id);
        ctx.strokeStyle = "#ff5267";
        ctx.lineWidth = 3 * ratio;
        ctx.beginPath();
        ctx.arc(x, y, radius + 3 * ratio, 0, Math.PI * 2);
        ctx.stroke();
      }
      const effect = effects.get(agent.id);
      if (!effect) continue;
      const age = Math.max(
        0,
        (seconds - effect.step * building.time_step_seconds) / DURATION,
      );
      ctx.globalAlpha = 1 - age;
      ctx.lineWidth = 1.5 * ratio;
      ctx.strokeStyle = ctx.fillStyle =
        effect.kind === "hurt"
          ? "#ff5267"
          : effect.kind === "discovery"
            ? "#ffd166"
            : "#65d9f3";
      const spread = radius + (reducedMotion ? 5 : 3 + age * 11) * ratio;
      ctx.beginPath();
      ctx.arc(x, y, spread, 0, Math.PI * 2);
      ctx.stroke();
      if (effect.kind === "hurt") {
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const angle = Math.PI / 4 + (i * Math.PI) / 2;
          ctx.moveTo(
            x + Math.cos(angle) * spread,
            y + Math.sin(angle) * spread,
          );
          ctx.lineTo(
            x + Math.cos(angle) * (spread + 4 * ratio),
            y + Math.sin(angle) * (spread + 4 * ratio),
          );
        }
        ctx.stroke();
      } else if (effect.kind === "discovery") {
        ctx.font = `bold ${13 * ratio}px system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText("!", x, y - radius - 5 * ratio);
      } else {
        const top = y - radius - 13 * ratio;
        ctx.strokeRect(x - 5 * ratio, top, 10 * ratio, 7 * ratio);
        ctx.beginPath();
        ctx.moveTo(x - 2 * ratio, top + 7 * ratio);
        ctx.lineTo(x - 2 * ratio, top + 10 * ratio);
        ctx.lineTo(x + 2 * ratio, top + 7 * ratio);
        ctx.stroke();
      }
    }
    ctx.restore();
  };
}
