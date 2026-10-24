import type { BuildingScenario, Obstruction, Point } from "../types/simulation";
import { clamp } from "./geometry";
import { nextObjectName } from "./names";
import { dragRectangle } from "./shapes";

export const furniturePresets = {
  desk: { label: "Desk", width: 1.4, height: 0.7 },
  table: { label: "Table", width: 1.8, height: 0.9 },
  chair: { label: "Chair", width: 0.5, height: 0.5 },
  cabinet: { label: "Cabinet", width: 0.9, height: 0.45 },
  bookshelf: { label: "Bookshelf", width: 1.2, height: 0.35 },
  bench: { label: "Bench", width: 1.8, height: 0.6 },
} as const;
export type FurnitureKind = keyof typeof furniturePresets;
export type FurnitureTool = `furniture-${FurnitureKind}`;
export function furnitureKind(tool: string): FurnitureKind | null {
  const kind = tool.replace(/^furniture-/, "");
  return tool.startsWith("furniture-") && Object.hasOwn(furniturePresets, kind)
    ? (kind as FurnitureKind)
    : null;
}
/** All enabled presets are honest full rectangular blockers. Symbol identity is session-only. */
export function addFurniture(
  building: BuildingScenario,
  kind: FurnitureKind,
  start: Point,
  end?: Point,
  id = `obstruction_${crypto.randomUUID()}`,
): BuildingScenario {
  const preset = furniturePresets[kind],
    width = Math.min(preset.width, building.width),
    height = Math.min(preset.height, building.height);
  const bounds = end
    ? dragRectangle(start, end, building)
    : {
        x: clamp(start.x - width / 2, 0, building.width - width),
        y: clamp(start.y - height / 2, 0, building.height - height),
        width,
        height,
      };
  return {
    ...building,
    obstructions: [
      ...building.obstructions,
      {
        id,
        name: nextObjectName(building, "obstructions", preset.label),
        ...bounds,
      },
    ],
  };
}

/** Drafting symbols stay inside the full collision footprint; they do not change physics. */
export function drawFurniture(
  ctx: CanvasRenderingContext2D,
  kind: FurnitureKind,
  r: Obstruction,
  px: number,
) {
  const line = (x: number, y: number, xx: number, yy: number) => {
    ctx.moveTo(r.x + x * r.width, r.y + y * r.height);
    ctx.lineTo(r.x + xx * r.width, r.y + yy * r.height);
  };
  ctx.lineWidth = px;
  ctx.beginPath();
  if (kind === "desk") {
    line(0.7, 0, 0.7, 1);
    for (const y of [0.32, 0.66]) line(0.7, y, 1, y);
  } else if (kind === "table") {
    for (const [x, y] of [
      [0.08, 0.08],
      [0.92, 0.08],
      [0.08, 0.92],
      [0.92, 0.92],
    ])
      line(x!, y!, x! < 0.5 ? 0.2 : 0.8, y! < 0.5 ? 0.25 : 0.75);
  } else if (kind === "chair") {
    line(0, 0.2, 1, 0.2);
    line(0.15, 0.2, 0.15, 0.85);
    line(0.15, 0.85, 0.85, 0.85);
    line(0.85, 0.85, 0.85, 0.2);
  } else if (kind === "cabinet") {
    line(0.5, 0, 0.5, 1);
    line(0.43, 0.4, 0.43, 0.6);
    line(0.57, 0.4, 0.57, 0.6);
  } else if (kind === "bookshelf") {
    for (const x of [0.25, 0.5, 0.75]) line(x, 0, x, 1);
    line(0, 0.25, 1, 0.25);
    line(0, 0.75, 1, 0.75);
  } else {
    line(0, 0.25, 1, 0.25);
    line(0.12, 0.25, 0.12, 1);
    line(0.88, 0.25, 0.88, 1);
    line(0.37, 0.25, 0.37, 1);
    line(0.63, 0.25, 0.63, 1);
  }
  ctx.stroke();
}
