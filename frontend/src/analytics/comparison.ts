import type { BuildingScenario, SimulationResult } from "../types/simulation";
import { withoutObjectNames } from "../editor/names";
import { openingChanges } from "./optimization";

export interface BaselineRecording {
  building: BuildingScenario;
  result: SimulationResult;
  source: "computed" | "recorded_demo";
}
export function comparisonContext(
  before: BaselineRecording,
  building: BuildingScenario,
  result: SimulationResult,
) {
  const original = withoutObjectNames(before.building);
  const current = withoutObjectNames(building);
  const differences: string[] = [];
  const equal = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  if (original.seed !== current.seed) differences.push("random seed changed");
  if (before.result.total_population !== result.total_population)
    differences.push("population changed");
  if (!equal(original.spawn_zones, current.spawn_zones))
    differences.push("spawn configuration changed");
  if (
    !equal(
      [original.disaster, original.tornado_zones],
      [current.disaster, current.tornado_zones],
    )
  )
    differences.push("hazard or shelter configuration changed");
  if (
    !equal(
      [
        original.time_step_seconds,
        original.max_steps,
        original.agent_radius,
        original.awareness,
      ],
      [
        current.time_step_seconds,
        current.max_steps,
        current.agent_radius,
        current.awareness,
      ],
    )
  )
    differences.push("simulation settings changed");
  if (
    !equal(
      [
        original.blocked_exit_ids,
        original.opening_events,
        original.window_escape_context,
      ],
      [
        current.blocked_exit_ids,
        current.opening_events,
        current.window_escape_context,
      ],
    )
  )
    differences.push("opening schedule or escape configuration changed");
  const positions = (run: SimulationResult) => {
    const frame = run.frames[0];
    return frame?.step === 0 && frame.agents.length === run.total_population
      ? frame.agents
          .toSorted((a, b) => a.id - b.id)
          .map((a) => [a.id, a.x, a.y])
      : null;
  };
  const oldPositions = positions(before.result),
    newPositions = positions(result);
  if (!oldPositions || !newPositions)
    differences.push("starting-position fairness is unverified");
  else if (!equal(oldPositions, newPositions))
    differences.push("initial occupant positions differ");
  if (before.source === "recorded_demo")
    differences.push(
      "the original is a bundled recording; engine-version equivalence is unverified",
    );
  const changes = openingChanges(original, current);
  for (const key of [
    "walls",
    "obstructions",
    "stair_areas",
    "windows",
  ] as const) {
    if (!equal(original[key], current[key]))
      changes.push(`${key.replace("_", " ")} changed`);
  }
  if (original.width !== current.width || original.height !== current.height)
    changes.push("workspace dimensions changed");
  if (
    !equal(original.exits, current.exits) &&
    !changes.some((change) => change.startsWith("Exit "))
  )
    changes.push("exits changed");
  if (
    !equal(original.doors, current.doors) &&
    !changes.some((change) => change.startsWith("Door "))
  )
    changes.push("doors changed");
  return { differences, changes };
}
