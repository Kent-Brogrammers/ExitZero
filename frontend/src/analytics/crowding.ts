import type { AnimationFrame } from "../types/simulation";
export const CROWD_ZONE = 2;
export const CROWDING_WARMUP_SECONDS = 3;
export interface CrowdingSpot {
  x: number;
  y: number;
  count: number;
  frame: AnimationFrame;
}
export function frameCrowding(
  frame: AnimationFrame,
  width: number,
  height: number,
): CrowdingSpot[] {
  const zones = new Map<string, CrowdingSpot>();
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
    const zone = zones.get(key) ?? { x, y, count: 0, frame };
    zone.count++;
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
        lastStep = -1;
      }
      if (
        frame &&
        frame.step > lastStep &&
        frame.step * timeStepSeconds >= CROWDING_WARMUP_SECONDS
      ) {
        for (const spot of frameCrowding(frame, width, height)) {
          const key = `${spot.x},${spot.y}`;
          if (spot.count > (peaks.get(key)?.count ?? 0)) peaks.set(key, spot);
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
