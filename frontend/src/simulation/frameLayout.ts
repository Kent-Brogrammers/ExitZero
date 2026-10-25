import type { AnimationFrame, BuildingScenario } from "../types/simulation";
import type { OpeningLayout } from "../editor/openings";

/** Replay the physical opening state at this timestamp, including reopenings. */
export function frameLayout(
  building: BuildingScenario,
  frame: AnimationFrame | null,
): OpeningLayout {
  if (!frame?.blocked_opening_ids) return building;
  const blocked = new Set(frame.blocked_opening_ids);
  return {
    ...building,
    closedDoorIds: building.doors
      .filter((door) => blocked.has(door.id))
      .map((door) => door.id),
    blocked_exit_ids: building.exits
      .filter((exit) => blocked.has(exit.id))
      .map((exit) => exit.id),
  };
}
