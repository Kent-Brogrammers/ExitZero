import { useEffect, useState } from "react";
import type { Point } from "../types/simulation";
import { FOOT_METRES, formatLength, getDisplayUnits } from "../utils/units";
import {
  measurementVisibility,
  type MeasurementVisibility,
} from "./measurements";
export { FOOT_METRES } from "../utils/units";
export const gridSpacings = {
  "1ft": { label: "1 foot", metres: FOOT_METRES },
  "2ft": { label: "2 feet", metres: 2 * FOOT_METRES },
  "5ft": { label: "5 feet", metres: 5 * FOOT_METRES },
  "0.5m": { label: "0.5 m", metres: 0.5 },
  "1m": { label: "1 m", metres: 1 },
} as const;
export function gridSpacingLabel(key: keyof typeof gridSpacings) {
  const spacing = gridSpacings[key];
  if (getDisplayUnits() === "metric") return formatLength(spacing.metres, 4);
  return key.endsWith("ft")
    ? spacing.label
    : `${formatLength(spacing.metres, 2)} (metric spacing)`;
}
export interface DraftingPreferences {
  visible: boolean;
  snap: boolean;
  /** Older preferences retain the editor's previously always-on wall snapping. */
  snapEndpoints?: boolean;
  measurements?: MeasurementVisibility;
  /** Display only: keep small/dense annotations quiet until hovered or selected. */
  declutterLabels?: boolean;
  showScale?: boolean;
  spacing: keyof typeof gridSpacings;
  doorMergeTolerance: number;
}
export const DRAFTING_STORAGE_KEY = "exitzero.studio.drafting";
export function useDraftingPreferences() {
  const [preferences, setPreferences] = useState<DraftingPreferences>(() => {
    try {
      const p = JSON.parse(
        localStorage.getItem(DRAFTING_STORAGE_KEY) ?? "null",
      );
      if (
        p &&
        typeof p.visible === "boolean" &&
        typeof p.snap === "boolean" &&
        Object.hasOwn(gridSpacings, p.spacing)
      )
        return {
          visible: p.visible,
          snap: p.snap,
          snapEndpoints:
            typeof p.snapEndpoints === "boolean" ? p.snapEndpoints : true,
          measurements: measurementVisibility(p.measurements),
          declutterLabels: p.declutterLabels !== false,
          showScale: p.showScale !== false,
          spacing: p.spacing,
          doorMergeTolerance: [0.02, 0.05, 0.1, 0.2].includes(
            p.doorMergeTolerance,
          )
            ? p.doorMergeTolerance
            : 0.1,
        };
    } catch {
      /* Drawing still works without storage. */
    }
    return {
      visible: false,
      snap: false,
      snapEndpoints: true,
      measurements: measurementVisibility(),
      declutterLabels: true,
      showScale: true,
      spacing: "2ft",
      doorMergeTolerance: 0.1,
    };
  });
  useEffect(() => {
    try {
      localStorage.setItem(DRAFTING_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      /* Preferences remain in memory. */
    }
  }, [preferences]);
  return [preferences, setPreferences] as const;
}
export function snapGridPoint(
  point: Point,
  spacing: number,
  bounds: { width: number; height: number },
): Point {
  return {
    x: Math.max(
      0,
      Math.min(bounds.width, Math.round(point.x / spacing) * spacing),
    ),
    y: Math.max(
      0,
      Math.min(bounds.height, Math.round(point.y / spacing) * spacing),
    ),
  };
}
/** Thin lines at small scales; snapping always retains the requested real interval. */
export function gridStride(
  spacing: number,
  cssScale: number,
  extent: number,
): number {
  return Math.max(
    1,
    Math.ceil(8 / (spacing * cssScale)),
    Math.ceil(extent / (spacing * 600)),
  );
}
