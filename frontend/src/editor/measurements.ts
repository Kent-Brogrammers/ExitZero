import type { BuildingScenario } from "../types/simulation";
import { formatLength } from "../utils/units";
import { clamp, wallLength } from "./geometry";
import type { OpeningLabel } from "./openings";

export const measurementOptions = [
  ["walls", "Walls"],
  ["doors", "Doors"],
  ["windows", "Windows"],
  ["exits", "Exits"],
] as const;
export type MeasurementKind = (typeof measurementOptions)[number][0];
export type MeasurementVisibility = Record<MeasurementKind, boolean>;
const defaults: MeasurementVisibility = {
  walls: false,
  doors: true,
  windows: true,
  exits: true,
};

/** Display preferences only; tolerate older and partially saved settings. */
export function measurementVisibility(value?: unknown): MeasurementVisibility {
  const source =
    value && typeof value === "object"
      ? (value as Partial<MeasurementVisibility>)
      : {};
  return Object.fromEntries(
    measurementOptions.map(([key]) => [
      key,
      typeof source[key] === "boolean" ? source[key] : defaults[key],
    ]),
  ) as MeasurementVisibility;
}

/** Full wall centreline lengths, positioned clear of the opening annotations. */
export function wallLengthLabels(
  building: Pick<BuildingScenario, "width" | "height" | "walls">,
  px: number,
  measure: (text: string) => number,
  reserved: readonly OpeningLabel[] = [],
): OpeningLabel[] {
  const labels: OpeningLabel[] = [];
  const placed = [...reserved];
  for (const wall of building.walls) {
    const length = wallLength(wall);
    if (!Number.isFinite(length) || length <= 0) continue;
    const text = formatLength(length, 2);
    const width = Math.min(measure(text), building.width),
      height = 13 * px;
    const anchor = {
      x: (wall.start.x + wall.end.x) / 2,
      y: (wall.start.y + wall.end.y) / 2,
    };
    let nx = -(wall.end.y - wall.start.y) / length;
    let ny = (wall.end.x - wall.start.x) / length;
    if (ny > 0 || (ny === 0 && nx < 0)) {
      nx = -nx;
      ny = -ny;
    }
    let candidate: OpeningLabel | undefined;
    for (let row = 0; row < 24; row++) {
      const offset =
        ((Math.abs(nx) * width) / 2 +
          (Math.abs(ny) * height) / 2 +
          8 * px +
          Math.floor(row / 2) * 17 * px) *
        (row % 2 ? -1 : 1);
      const x = clamp(
        anchor.x + nx * offset - width / 2,
        0,
        Math.max(0, building.width - width),
      );
      const y = clamp(
        anchor.y + ny * offset + height / 2,
        Math.min(height, building.height),
        building.height,
      );
      candidate = { id: wall.id, text, x, y, width, height, anchor };
      if (
        !placed.some(
          (p) =>
            x < p.x + p.width + 3 * px &&
            p.x < x + width + 3 * px &&
            y - height < p.y + 3 * px &&
            p.y - p.height < y + 3 * px,
        )
      )
        break;
    }
    labels.push(candidate!);
    placed.push(candidate!);
  }
  return labels;
}
