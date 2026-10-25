import type { SimulationResult } from "../types/simulation";
export interface ReplayTarget {
  source: SimulationResult;
  step: number;
  request: number;
  play?: boolean;
}
/** Snapshot steps refer to recorded frames, not seconds or array positions. */
export function snapshotFrameIndex(
  result: SimulationResult,
  step: number,
): number {
  return result.frames.findIndex((frame) => frame.step === step);
}
