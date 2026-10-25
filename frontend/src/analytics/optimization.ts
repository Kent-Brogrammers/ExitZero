import { formatLength } from "../utils/units";
import { buildingError } from "../editor/geometry";
import type {
  BuildingScenario,
  OptimizationCandidate,
  OptimizationResult,
  SimulationMetrics,
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

export function openingChanges(
  source: BuildingScenario,
  candidate: BuildingScenario,
): string[] {
  return (["doors", "exits"] as const).flatMap((kind) =>
    candidate[kind].flatMap((opening) => {
      const old = source[kind].find((item) => item.id === opening.id);
      return old && old.width !== opening.width
        ? [
            `${kind === "doors" ? "Door" : "Exit"} ${old.name ?? old.id}: ${formatLength(old.width)} → ${formatLength(opening.width)}`,
          ]
        : [];
    }),
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
  ] as const) {
    for (const element of next[kind]) {
      const name = current[kind].find((item) => item.id === element.id)?.name;
      if (name !== undefined) element.name = name;
    }
  }
  const problem = buildingError(next);
  if (problem) throw new Error(`Cannot apply candidate: ${problem}`);
  return next;
}
