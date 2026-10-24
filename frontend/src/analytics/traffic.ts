import type { TrafficSample } from "../types/simulation";

/** Aggregate actual visits into bounded, equally sized world-space bins. */
export function trafficCells(
  samples: TrafficSample[],
  width: number,
  height: number,
) {
  const size = Math.max(width, height) / 96;
  const columns = Math.ceil(width / size),
    rows = Math.ceil(height / size);
  const counts = new Map<number, number>();
  for (const sample of samples) {
    if (
      !Number.isFinite(sample.x) ||
      !Number.isFinite(sample.y) ||
      !Number.isFinite(sample.visits) ||
      sample.x < 0 ||
      sample.y < 0 ||
      sample.x > width ||
      sample.y > height ||
      sample.visits <= 0
    )
      continue;
    const column = Math.min(columns - 1, Math.floor(sample.x / size)),
      row = Math.min(rows - 1, Math.floor(sample.y / size));
    const key = row * columns + column;
    counts.set(key, (counts.get(key) ?? 0) + sample.visits);
  }
  return [...counts].map(([key, visits]) => {
    const x = (key % columns) * size,
      y = Math.floor(key / columns) * size;
    return {
      x,
      y,
      width: Math.min(size, width - x),
      height: Math.min(size, height - y),
      visits,
    };
  });
}
