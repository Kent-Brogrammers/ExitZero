import type { BuildingScenario } from "../types/simulation";
import type { CanvasPalette } from "../styles/canvasPalette";
import type { DraftingPreferences } from "./drafting";
import type { FurnitureKind } from "./furniture";
import { drawLayout } from "./draw";
import { measurementVisibility } from "./measurements";

export interface FloorPlanImageOptions {
  includeGrid: boolean;
  includeMeasurements: boolean;
}

/** A bounded bitmap, with room for text even on unusually thin drawings. */
export function floorPlanImageSize(
  building: Pick<BuildingScenario, "width" | "height">,
) {
  if (
    !Number.isFinite(building.width) ||
    !Number.isFinite(building.height) ||
    building.width <= 0 ||
    building.height <= 0
  )
    throw new Error(
      "The drawing needs valid dimensions before it can be exported.",
    );
  const scale = 3200 / Math.max(building.width, building.height);
  return {
    width: Math.max(256, Math.round(building.width * scale)),
    height: Math.max(256, Math.round(building.height * scale)),
  };
}

/** Redraw the whole world, never copy the editor's zoom, selection, or draft. */
export async function createFloorPlanImage(
  building: BuildingScenario,
  options: FloorPlanImageOptions,
  drafting: DraftingPreferences,
  furniture: ReadonlyMap<string, FurnitureKind>,
  palette: CanvasPalette,
  ownerDocument: Document = document,
): Promise<Blob> {
  const { width, height } = floorPlanImageSize(building);
  const canvas = ownerDocument.createElement("canvas");
  // drawLayout uses CSS dimensions and DPI. Render at 2× for sharp text/lines.
  const cssWidth = width / 2,
    cssHeight = height / 2;
  canvas.width = width;
  canvas.height = height;
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    width: `${cssWidth}px`,
    height: `${cssHeight}px`,
  });
  ownerDocument.body.append(canvas);
  try {
    if (!canvas.getContext("2d") || typeof canvas.toBlob !== "function")
      throw new Error("PNG export is unavailable in this browser.");
    // Leave a border for strokes extending beyond boundary wall centrelines.
    const thickness = Math.max(0, ...building.walls.map((w) => w.thickness));
    const fit = Math.min(
      (cssWidth - 64) / (building.width + thickness),
      (cssHeight - 64) / (building.height + thickness),
    );
    drawLayout(canvas, building, null, undefined, 2, palette, {
      camera: {
        zoom:
          fit /
          Math.min(cssWidth / building.width, cssHeight / building.height),
        pan: { x: 0, y: 0 },
      },
      furniture,
      grid: { ...drafting, visible: options.includeGrid },
      showDimensions: options.includeMeasurements,
      measurements: options.includeMeasurements
        ? measurementVisibility(drafting.measurements)
        : { walls: false, doors: false, windows: false, exits: false },
      // Exports include all enabled measurement types, without hover-only labels.
      declutterLabels: false,
    });
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob?.size && blob.type === "image/png") resolve(blob);
        else
          reject(
            new Error(
              "The browser could not create the PNG. Please try again.",
            ),
          );
      }, "image/png");
    });
  } finally {
    canvas.remove();
    canvas.width = canvas.height = 0;
  }
}

export function downloadFloorPlanImage(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "exitzero-floor-plan.png";
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
