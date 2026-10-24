import type { AnimationFrame, TrafficSample } from "../types/simulation";
import { trafficBins } from "../analytics/traffic";

/** Accumulate delivered frames once, independently of animation redraws. */
export function createLiveTraffic(width: number, height: number) {
  const cells = new Map<string, TrafficSample>();
  let lastStep = -1;
  const size = trafficBins([], width, height).size;
  return (frame: AnimationFrame | null) => {
    if (!frame || frame.step < lastStep) {
      cells.clear();
      lastStep = -1;
    }
    if (frame && frame.step > lastStep) {
      // Step zero establishes initial positions; trails start with subsequent observations.
      if (frame.step > 0)
        for (const bin of trafficBins(
          frame.agents.map((a) => ({ x: a.x, y: a.y, visits: 1 })),
          width,
          height,
        ).bins) {
          const key = `${Math.round(bin.x / size)},${Math.round(bin.y / size)}`;
          const cell = cells.get(key) ?? { ...bin, visits: 0 };
          cell.visits += bin.visits;
          cells.set(key, cell);
        }
      lastStep = frame.step;
    }
    return trafficBins([...cells.values()], width, height);
  };
}
