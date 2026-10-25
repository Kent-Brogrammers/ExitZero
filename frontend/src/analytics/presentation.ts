import type {
  SimulationMetrics,
  StressScenarioResult,
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

export function outcomeExplanation(metrics: SimulationMetrics): string {
  if (metrics.status === "completed" && (metrics.sheltered ?? 0) > 0)
    return `All occupants reached safety: ${metrics.sheltered} sheltered and ${metrics.evacuated} evacuated through exits.`;
  if (metrics.status === "completed")
    return "All occupants evacuated. Clearance was measured for this run.";
  if (metrics.status === "timeout")
    return "The simulation reached its step limit with occupants still inside. No full-evacuation clearance was measured.";
  return "The run ended before everyone evacuated. The engine stops when routes are unavailable or movement stalls. The API does not report which stopping condition occurred. Zero trapped does not mean all remaining occupants can evacuate.";
}
