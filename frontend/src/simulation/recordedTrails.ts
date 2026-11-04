import type { SimulationResult } from "../types/simulation";
import { createLiveTraffic } from "./liveTraffic";

/** Replay backend interval weights; sampling and redraws never calculate physics. */
export function createRecordedTrails(result: SimulationResult) {
  let previous = -1;
  const accumulate = createLiveTraffic(result.width, result.height);
  return (index: number) => {
    const end = Math.max(
      0,
      Math.min(result.frames.length - 1, Math.floor(index)),
    );
    if (end < previous) {
      accumulate(null);
      previous = -1;
    }
    for (let i = previous + 1; i <= end; i++) {
      accumulate(result.frames[i]!);
    }
    previous = end;
    return accumulate(result.frames[end] ?? null);
  };
}
