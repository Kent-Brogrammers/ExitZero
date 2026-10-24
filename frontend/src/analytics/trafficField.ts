import { trafficBins } from "./traffic";

/** Smooth a visit field for display only. The source visit totals are unchanged. */
export function trafficField(
  data: ReturnType<typeof trafficBins>,
  width: number,
  height: number,
  radius: number,
) {
  const scale = Math.min(600 / Math.max(width, height), 3 / data.size);
  const columns = Math.max(1, Math.ceil(width * scale));
  const rows = Math.max(1, Math.ceil(height * scale));
  const values = new Float32Array(columns * rows);
  const spread = Math.max(data.size, radius);
  const sigma = spread / 2;
  for (const bin of data.bins) {
    const x = Math.min(width, bin.x + data.size / 2),
      y = Math.min(height, bin.y + data.size / 2);
    const left = Math.max(0, Math.floor((x - spread) * scale)),
      right = Math.min(columns - 1, Math.ceil((x + spread) * scale));
    const top = Math.max(0, Math.floor((y - spread) * scale)),
      bottom = Math.min(rows - 1, Math.ceil((y + spread) * scale));
    for (let row = top; row <= bottom; row++)
      for (let col = left; col <= right; col++) {
        const dx = (col + 0.5) / scale - x,
          dy = (row + 0.5) / scale - y;
        const distance = dx * dx + dy * dy;
        if (distance <= spread * spread)
          values[row * columns + col]! +=
            bin.visits * Math.exp(-distance / (2 * sigma * sigma));
      }
  }
  let peak = 0;
  for (const value of values) peak = Math.max(peak, value);
  return { columns, rows, values, peak };
}

export function fieldPixels(field: ReturnType<typeof trafficField>) {
  const pixels = new Uint8ClampedArray(field.values.length * 4);
  const stops = [
    [35, 90, 215],
    [23, 198, 213],
    [70, 222, 143],
    [251, 207, 75],
    [250, 89, 68],
  ];
  if (!field.peak) return pixels;
  for (let i = 0; i < field.values.length; i++) {
    const normalized = field.values[i]! / field.peak;
    if (normalized < 0.015) continue;
    const position = Math.pow(normalized, 0.65) * (stops.length - 1);
    const index = Math.min(stops.length - 2, Math.floor(position));
    const fraction = position - index;
    for (let channel = 0; channel < 3; channel++)
      pixels[i * 4 + channel] =
        stops[index]![channel]! * (1 - fraction) +
        stops[index + 1]![channel]! * fraction;
    pixels[i * 4 + 3] = Math.round(220 * Math.min(1, normalized * 5));
  }
  return pixels;
}
