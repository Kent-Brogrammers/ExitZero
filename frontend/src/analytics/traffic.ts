import type { CongestionSample, TrafficSample } from "../types/simulation";

/** Adapt backend crowd-delay weights to the shared display-only field renderer. */
export function congestionBins(
  samples: CongestionSample[],
  width: number,
  height: number,
) {
  return trafficBins(
    samples.map(({ x, y, crowd_delay_seconds }) => ({
      x,
      y,
      visits: crowd_delay_seconds,
    })),
    width,
    height,
  );
}

export function trafficBins(
  samples: TrafficSample[],
  width: number,
  height: number,
) {
  const size = Math.max(0.25, Math.max(width, height) / 160);
  const bins = new Map<string, { x: number; y: number; visits: number }>();
  for (const sample of samples) {
    if (
      ![sample.x, sample.y, sample.visits].every(Number.isFinite) ||
      sample.x < 0 ||
      sample.y < 0 ||
      sample.x > width ||
      sample.y > height ||
      sample.visits <= 0
    )
      continue;
    const col = Math.min(
      Math.ceil(width / size) - 1,
      Math.floor(sample.x / size),
    );
    const row = Math.min(
      Math.ceil(height / size) - 1,
      Math.floor(sample.y / size),
    );
    const key = `${col},${row}`;
    const bin = bins.get(key) ?? { x: col * size, y: row * size, visits: 0 };
    bin.visits += sample.visits;
    bins.set(key, bin);
  }
  return {
    size,
    bins: [...bins.values()],
    max: Math.max(0, ...[...bins.values()].map((bin) => bin.visits)),
  };
}

/** Rectangular-bin adapter for the audit layout overlay and its regression tests. */
export function trafficCells(
  samples: TrafficSample[],
  width: number,
  height: number,
) {
  const { size, bins } = trafficBins(samples, width, height);
  return bins.map((bin) => ({
    ...bin,
    width: Math.min(size, width - bin.x),
    height: Math.min(size, height - bin.y),
  }));
}
