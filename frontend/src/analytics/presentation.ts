import type {
  SimulationMetrics,
  StressScenarioResult,
  SimulationResult,
} from "../types/simulation";

export function scenarioTitle(scenario: StressScenarioResult): string {
  const { blocked_exit_ids: exits, added_obstructions: obstructions } =
    scenario.modifications;
  if (exits.length && !obstructions.length)
    return `Exit ${exits.join(", ")} blocked`;
  if (obstructions.length && !exits.length)
    return `Obstruction: ${obstructions.map((o) => o.id).join(", ")}`;
  return scenario.description.split(/(?<=[.!?])\s/)[0] || scenario.scenario_id;
}

export function outcomeExplanation(
  metrics: SimulationMetrics,
  reason?: SimulationResult["termination_reason"],
): string {
  if (metrics.status === "completed" && (metrics.sheltered ?? 0) > 0)
    return `All occupants reached safety: ${metrics.sheltered} sheltered and ${metrics.evacuated} evacuated through exits.`;
  if (metrics.status === "completed")
    return "All occupants evacuated. Clearance was measured for this run.";
  if (metrics.status === "timeout")
    return "The simulation reached its step limit with occupants still inside. No full-evacuation clearance was measured.";
  if (reason === "no_active_routes")
    return "The engine ended because no remaining occupant had an active route and no pending change could restart routing. This does not prove that every remaining occupant is physically trapped. No complete clearance was measured.";
  if (reason === "movement_stagnation")
    return "The engine ended after its measured interval without movement or new information. This does not establish the cause for each remaining occupant. No complete clearance was measured.";
  return "The run ended before everyone evacuated. The engine stops when routes are unavailable or movement stalls. The API does not report which stopping condition occurred. Zero trapped does not mean all remaining occupants can evacuate.";
}

export function clearanceChange(
  before: number | null,
  after: number | null,
  timeStep?: number,
): string {
  if (before === null || after === null)
    return "Clearance comparison unavailable: both runs need complete clearance.";
  const delta = after - before;
  return `${delta > 0 ? "+" : ""}${delta} steps${timeStep !== undefined ? ` / ${(delta * timeStep).toFixed(2)} s` : ""}${before > 0 ? ` (${delta > 0 ? "+" : ""}${((delta / before) * 100).toFixed(1)}%)` : ""}`;
}
