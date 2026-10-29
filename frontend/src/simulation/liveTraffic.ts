import type { AnimationFrame, CongestionSample } from "../types/simulation";
import { congestionBins, trafficBins } from "../analytics/traffic";

/** Consume every backend interval before React batches live display updates. */
export function createLiveCongestion(width: number, height: number) {
  const cells = new Map<string, CongestionSample>();
  let lastStep = -1;
  let available = false;
  let samples: CongestionSample[] | undefined;
  const size = trafficBins([], width, height).size;
  return (frame: AnimationFrame | null) => {
    if (!frame || frame.step < lastStep) {
      cells.clear();
      lastStep = -1;
      available = false;
      samples = undefined;
    }
    if (frame && frame.step > lastStep) {
      available ||= frame.congestion_samples !== undefined;
      for (const bin of congestionBins(
        frame.congestion_samples ?? [],
        width,
        height,
      ).bins) {
        const key = `${Math.round(bin.x / size)},${Math.round(bin.y / size)}`;
        const cell = cells.get(key) ?? {
          // Keep the display representative inside its bin: re-binning a
          // floating-point corner can otherwise move it into the prior bin.
          x: Math.min(width, bin.x + size / 2),
          y: Math.min(height, bin.y + size / 2),
          crowd_delay_seconds: 0,
        };
        // Replace entries so already delivered snapshots remain immutable.
        cells.set(key, {
          ...cell,
          crowd_delay_seconds: cell.crowd_delay_seconds + bin.visits,
        });
      }
      samples = available ? [...cells.values()] : undefined;
      lastStep = frame.step;
    }
    return samples;
  };
}

/** Display adapter; weights are crowd-delay seconds, never counted positions. */
export function createLiveTraffic(width: number, height: number) {
  const accumulate = createLiveCongestion(width, height);
  return (frame: AnimationFrame | null) => {
    return congestionBins(accumulate(frame) ?? [], width, height);
  };
}
