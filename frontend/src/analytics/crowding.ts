import type { AnimationFrame } from "../types/simulation";
export const CROWD_ZONE = 2;
export const CROWDING_WARMUP_SECONDS = 3;
export interface CrowdingSpot {
  x: number;
  y: number;
  count: number;
  frame: AnimationFrame;
  agentIds: number[];
  queuedCount: number;
}

function queuedAgents(frame: AnimationFrame) {
  return new Set(
    (frame.window_states ?? []).flatMap((window) => [
      ...window.queue_agent_ids,
      ...(window.traversing_agent_id === null
        ? []
        : [window.traversing_agent_id]),
    ]),
  );
}
export function frameCrowding(
  frame: AnimationFrame,
  width: number,
  height: number,
): CrowdingSpot[] {
  const zones = new Map<string, CrowdingSpot>();
  const queued = queuedAgents(frame);
  for (const agent of frame.agents) {
    if (
      ![agent.x, agent.y].every(Number.isFinite) ||
      agent.x < 0 ||
      agent.y < 0 ||
      agent.x > width ||
      agent.y > height
    )
      continue;
    const x =
      Math.min(
        Math.ceil(width / CROWD_ZONE) - 1,
        Math.floor(agent.x / CROWD_ZONE),
      ) * CROWD_ZONE;
    const y =
      Math.min(
        Math.ceil(height / CROWD_ZONE) - 1,
        Math.floor(agent.y / CROWD_ZONE),
      ) * CROWD_ZONE;
    const key = `${x},${y}`;
    const zone = zones.get(key) ?? {
      x,
      y,
      count: 0,
      frame,
      agentIds: [],
      queuedCount: 0,
    };
    zone.count++;
    zone.agentIds.push(agent.id);
    if (queued.has(agent.id)) zone.queuedCount++;
    zones.set(key, zone);
  }
  return [...zones.values()];
}
export function createCrowdingTracker(
  width: number,
  height: number,
  timeStepSeconds = 1,
) {
  const peaks = new Map<string, CrowdingSpot>();
  const listeners = new Set<() => void>();
  let snapshot: CrowdingSpot[] = [];
  let lastStep = -1;
  const starts = new Map<number, { x: number; y: number }>();
  const moved = new Set<number>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    add(frame: AnimationFrame | null) {
      if (!frame || frame.step < lastStep) {
        peaks.clear();
        starts.clear();
        moved.clear();
        lastStep = -1;
      }
      if (frame && frame.step > lastStep) {
        const queued = queuedAgents(frame);
        const agents = frame.agents.filter((agent) => {
          if (![agent.x, agent.y].every(Number.isFinite)) return false;
          const start = starts.get(agent.id);
          if (!start) {
            starts.set(agent.id, { x: agent.x, y: agent.y });
            return queued.has(agent.id);
          }
          if (Math.hypot(agent.x - start.x, agent.y - start.y) >= CROWD_ZONE)
            moved.add(agent.id);
          return moved.has(agent.id) || queued.has(agent.id);
        });
        // Use the same eligible occupants for both ranks and snapshot heatmaps.
        const rankedFrame = {
          ...frame,
          agents:
            frame.step * timeStepSeconds >= CROWDING_WARMUP_SECONDS
              ? agents
              : [],
        };
        for (const spot of frameCrowding(rankedFrame, width, height)) {
          const key = `${spot.x},${spot.y}`;
          const previous = peaks.get(key);
          if (
            !previous ||
            spot.count > previous.count ||
            (spot.count === previous.count &&
              spot.queuedCount > previous.queuedCount)
          )
            peaks.set(key, spot);
        }
        lastStep = frame.step;
      }
      snapshot = [...peaks.values()]
        .sort(
          (a, b) =>
            b.count - a.count ||
            a.frame.step - b.frame.step ||
            a.y - b.y ||
            a.x - b.x,
        )
        .slice(0, 3);
      listeners.forEach((listener) => listener());
    },
  };
}
