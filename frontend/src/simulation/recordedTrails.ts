import type { SimulationResult, TrafficSample } from "../types/simulation";
import { trafficBins } from "../analytics/traffic";

/** One observation per occupant per recorded frame; never invent intermediate visits. */
export function createRecordedTrails(result: SimulationResult) {
  let previous = 0;
  const counts = new Map<string, TrafficSample>();
  const size = trafficBins([], result.width, result.height).size;
  return (index: number) => {
    const end = Math.max(
      0,
      Math.min(result.frames.length - 1, Math.floor(index)),
    );
    if (end < previous) {
      counts.clear();
      previous = 0;
    }
    for (let i = previous + 1; i <= end; i++) {
      for (const agent of result.frames[i]!.agents) {
        if (
          !Number.isFinite(agent.x) ||
          !Number.isFinite(agent.y) ||
          agent.x < 0 ||
          agent.y < 0 ||
          agent.x > result.width ||
          agent.y > result.height
        )
          continue;
        const col = Math.min(
          Math.ceil(result.width / size) - 1,
          Math.floor(agent.x / size),
        );
        const row = Math.min(
          Math.ceil(result.height / size) - 1,
          Math.floor(agent.y / size),
        );
        const key = `${col},${row}`;
        const value = counts.get(key) ?? {
          x: col * size,
          y: row * size,
          visits: 0,
        };
        value.visits++;
        counts.set(key, value);
      }
    }
    previous = end;
    return trafficBins([...counts.values()], result.width, result.height);
  };
}
