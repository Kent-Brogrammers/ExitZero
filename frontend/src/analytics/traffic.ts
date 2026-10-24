import type { TrafficSample } from "../types/simulation";

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
