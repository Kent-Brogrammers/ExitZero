import type {
  AgentPosition,
  AnimationFrame,
  BuildingScenario,
  Point,
  HazardArea,
} from "../types/simulation";
import { frameIndexAtTime } from "./playback";
import { solidWallSegments } from "../editor/openings";
import { frameLayout } from "./frameLayout";

interface Segment {
  start: Point;
  end: Point;
  padding: number;
}

function pointDistance(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x,
    dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared
    ? Math.max(
        0,
        Math.min(
          1,
          ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
        ),
      )
    : 0;
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    ex = d.x - c.x,
    ey = d.y - c.y;
  const determinant = dx * ey - dy * ex;
  if (Math.abs(determinant) > 1e-12) {
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / determinant;
    const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / determinant;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    pointDistance(a, c, d),
    pointDistance(b, c, d),
    pointDistance(c, a, b),
    pointDistance(d, a, b),
  );
}

function solidWalls(
  building: BuildingScenario,
  frame: AnimationFrame,
): Segment[] {
  return building.walls.flatMap((wall) =>
    solidWallSegments(building, wall, frame.window_states).map(
      ([start, end]) => ({
        start,
        end,
        padding: building.agent_radius + wall.thickness / 2,
      }),
    ),
  );
}

/** Conservative display guard only. It never finds routes or changes physics. */
function canBlend(
  a: Point,
  b: Point,
  walls: Segment[],
  building: BuildingScenario,
) {
  if (a.x === b.x && a.y === b.y) return true;
  const left = Math.min(a.x, b.x),
    right = Math.max(a.x, b.x),
    top = Math.min(a.y, b.y),
    bottom = Math.max(a.y, b.y);
  for (const { start, end, padding } of walls) {
    if (
      right < Math.min(start.x, end.x) - padding ||
      left > Math.max(start.x, end.x) + padding ||
      bottom < Math.min(start.y, end.y) - padding ||
      top > Math.max(start.y, end.y) + padding
    )
      continue;
    if (segmentDistance(a, b, start, end) < padding - 1e-8) return false;
  }
  for (const obstacle of building.obstructions) {
    const radius = building.agent_radius;
    const x = obstacle.x - radius,
      y = obstacle.y - radius;
    const maxX = obstacle.x + obstacle.width + radius,
      maxY = obstacle.y + obstacle.height + radius;
    if (right < x || left > maxX || bottom < y || top > maxY) continue;
    let enter = 0,
      leave = 1;
    let crosses = true;
    const clips: [number, number][] = [
      [a.x - b.x, a.x - x],
      [b.x - a.x, maxX - a.x],
      [a.y - b.y, a.y - y],
      [b.y - a.y, maxY - a.y],
    ];
    for (const [p, q] of clips) {
      if (Math.abs(p) < 1e-12) {
        if (q < 0) {
          crosses = false;
          break;
        }
      } else if (p < 0) enter = Math.max(enter, q / p);
      else leave = Math.min(leave, q / p);
      if (enter > leave) {
        crosses = false;
        break;
      }
    }
    if (crosses) return false;
  }
  return true;
}

/**
 * Reuses a display buffer and one ID map per frame pair; recorded data stays immutable.
 * Missing IDs are held/introduced at the next sample, never routed to an exit.
 * A straight blend can differ from the actual path; unsafe blends hold and jump.
 * Connor must supply denser samples around turns to make those intervals smooth.
 */
export function createFrameSampler(
  building: BuildingScenario,
  frames: AnimationFrame[],
  timeStep: number,
) {
  let pair = -1;
  let pursuitCanBlend = false;
  let display: AnimationFrame | null = null;
  let entries: {
    source: AgentPosition;
    target: AgentPosition;
    display: AgentPosition;
  }[] = [];
  let hazardEntries: {
    source: HazardArea;
    target: HazardArea;
    display: HazardArea;
    blend: boolean;
  }[] = [];
  return (seconds: number): AnimationFrame | null => {
    const index = frameIndexAtTime(frames, timeStep, seconds);
    const source = frames[index];
    if (!source) return null;
    const next = frames[index + 1];
    if (!next || seconds <= source.step * timeStep) return source;
    if (pair !== index) {
      pair = index;
      const layout = frameLayout(building, source);
      const walls = solidWalls(layout, source);
      pursuitCanBlend =
        !!source.pursuit &&
        !!next.pursuit &&
        canBlend(source.pursuit.stalker, next.pursuit.stalker, walls, layout);
      const targets = new Map(next.agents.map((agent) => [agent.id, agent]));
      entries = source.agents.map((agent) => {
        const target = targets.get(agent.id);
        return {
          source: agent,
          target:
            target && canBlend(agent, target, walls, layout) ? target : agent,
          display: { ...agent },
        };
      });
      const nextAreas = new Map(
        next.disaster_state?.areas.map((area) => [area.id, area]),
      );
      hazardEntries = (source.disaster_state?.areas ?? []).map((area) => {
        const target = nextAreas.get(area.id) ?? area;
        const padding =
          Math.max(area.radius, target.radius) * 1.3 +
          building.agent_radius +
          (building.disaster?.dynamics?.enabled
            ? building.disaster.dynamics.shelter_clearance
            : 0);
        const blend =
          source.disaster_state?.kind !== "tornado" ||
          (building.tornado_zones ?? []).every((zone) => {
            const corners = [
              { x: zone.x, y: zone.y },
              { x: zone.x + zone.width, y: zone.y },
              { x: zone.x + zone.width, y: zone.y + zone.height },
              { x: zone.x, y: zone.y + zone.height },
            ];
            return corners.every(
              (corner, index) =>
                segmentDistance(
                  area.center,
                  target.center,
                  corner,
                  corners[(index + 1) % 4]!,
                ) >=
                padding - 1e-8,
            );
          });
        return {
          source: area,
          target,
          display: { ...area, center: { ...area.center } },
          blend,
        };
      });
      display = {
        pursuit: source.pursuit
          ? { ...source.pursuit, stalker: { ...source.pursuit.stalker } }
          : undefined,
        step: source.step,
        sheltered: source.sheltered,
        disaster_state: source.disaster_state
          ? {
              kind: source.disaster_state.kind,
              areas: hazardEntries.map((entry) => entry.display),
            }
          : undefined,
        blocked_opening_ids: source.blocked_opening_ids,
        window_states: source.window_states,
        agents: entries.map((entry) => entry.display),
      };
    }
    const alpha = Math.max(
      0,
      Math.min(
        1,
        (seconds - source.step * timeStep) /
          ((next.step - source.step) * timeStep),
      ),
    );
    for (const entry of hazardEntries) {
      const blend = entry.blend ? alpha : 0;
      entry.display.center.x =
        entry.source.center.x +
        (entry.target.center.x - entry.source.center.x) * blend;
      entry.display.center.y =
        entry.source.center.y +
        (entry.target.center.y - entry.source.center.y) * blend;
      entry.display.radius =
        entry.source.radius +
        (entry.target.radius - entry.source.radius) * blend;
    }
    for (const entry of entries) {
      entry.display.x =
        entry.source.x + (entry.target.x - entry.source.x) * alpha;
      entry.display.y =
        entry.source.y + (entry.target.y - entry.source.y) * alpha;
    }
    if (display?.pursuit && source.pursuit) {
      const target = next.pursuit?.stalker ?? source.pursuit.stalker;
      const blend = pursuitCanBlend ? alpha : 0;
      display.pursuit.stalker.x =
        source.pursuit.stalker.x +
        (target.x - source.pursuit.stalker.x) * blend;
      display.pursuit.stalker.y =
        source.pursuit.stalker.y +
        (target.y - source.pursuit.stalker.y) * blend;
    }
    return display;
  };
}
