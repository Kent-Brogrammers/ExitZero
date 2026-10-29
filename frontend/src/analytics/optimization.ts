import { formatLength } from "../utils/units";
import { buildingError } from "../editor/geometry";
import type {
  BuildingScenario,
  OptimizationCandidate,
  OptimizationResult,
  SimulationMetrics,
  Opening,
} from "../types/simulation";

export interface OptimizationEvaluation {
  source: BuildingScenario;
  result: OptimizationResult;
  applied: OptimizationCandidate | null;
}

/** Same lexicographic objective as SimulationMetrics::compare_severity. */
export function compareMetrics(
  a: SimulationMetrics,
  b: SimulationMetrics,
): number {
  for (const [left, right] of [
    [a.remaining, b.remaining],
    [a.trapped, b.trapped],
    [a.clearance_steps ?? Infinity, b.clearance_steps ?? Infinity],
  ]) {
    if (left !== right) return left! < right! ? -1 : 1;
  }
  return 0;
}

export const clearanceLabel = (steps: number | null) =>
  steps === null ? "No measured clearance" : `${steps} steps`;

export function openingWidthChanges(
  source: BuildingScenario,
  candidate: BuildingScenario,
) {
  return (["doors", "exits"] as const).flatMap((kind) =>
    candidate[kind].flatMap(
      (
        proposed,
      ): { kind: typeof kind; original: Opening; proposed: Opening }[] => {
        const original = source[kind].find(
          (opening) => opening.id === proposed.id,
        );
        return original && original.width !== proposed.width
          ? [{ kind, original, proposed }]
          : [];
      },
    ),
  );
}

export function improvementLabel(
  before: SimulationMetrics,
  after: SimulationMetrics,
  timeStep: number,
): string {
  if (before.clearance_steps === null || after.clearance_steps === null)
    return "Full clearance comparison unavailable";
  const steps = before.clearance_steps - after.clearance_steps;
  const amount = Math.abs(steps);
  const percent =
    before.clearance_steps > 0
      ? ` · ${((amount / before.clearance_steps) * 100).toFixed(1)}%`
      : "";
  return `${amount} steps · ${(amount * timeStep).toFixed(2)} s${percent} ${steps > 0 ? "faster" : steps < 0 ? "slower" : "change"}`;
}

export function openingChanges(
  source: BuildingScenario,
  candidate: BuildingScenario,
): string[] {
  return openingWidthChanges(source, candidate).map(
    ({ kind, original, proposed }) =>
      `${kind === "doors" ? "Door" : "Exit"} ${original.name ?? original.id}: ${formatLength(original.width)} → ${formatLength(proposed.width)}`,
  );
}

export function applyOptimizationCandidate(
  current: BuildingScenario,
  baseline: SimulationMetrics,
  candidate: OptimizationCandidate,
): BuildingScenario {
  if (compareMetrics(candidate.metrics, baseline) >= 0)
    throw new Error(
      "This candidate is not a strict improvement over its baseline.",
    );
  const next = structuredClone(candidate.building);
  // Keep presentation names even when an engine response omits that metadata.
  for (const kind of [
    "walls",
    "doors",
    "exits",
    "spawn_zones",
    "obstructions",
    "placed_occupants",
  ] as const) {
    for (const element of next[kind] ?? []) {
      const name = current[kind]?.find((item) => item.id === element.id)?.name;
      if (name !== undefined) element.name = name;
    }
  }
  const problem = buildingError(next);
  if (problem) throw new Error(`Cannot apply candidate: ${problem}`);
  return next;
}
