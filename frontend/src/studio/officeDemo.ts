import office from "../editor/presets/office-demo.json";
import type { BuildingScenario, SimulationResult } from "../types/simulation";

export const officeDemoBuilding: BuildingScenario = office;
export const officeDemoProvenance = {
  engine: "99136f4",
  recordedOn: "2026-10-24",
  source: "POST /api/simulate",
} as const;

/** Actual Rust output for officeDemoBuilding; loaded only when the demo is opened. */
export async function loadOfficeDemo(): Promise<SimulationResult> {
  const response = await fetch(
    new URL("./office-demo/recording.json", import.meta.url),
  );
  if (!response.ok) throw new Error("Office demo recording is unavailable.");
  return (await response.json()) as SimulationResult;
}
