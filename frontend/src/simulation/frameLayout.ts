import type { AnimationFrame, BuildingScenario } from "../types/simulation";

/** Replay the physical opening state at this timestamp, including reopenings. */
export function frameLayout(
  building: BuildingScenario,
  frame: AnimationFrame | null,
): BuildingScenario {
  if (!frame?.blocked_opening_ids) return building;
  const blocked = new Set(frame.blocked_opening_ids);
  return {
    ...building,
    doors: building.doors.filter((door) => !blocked.has(door.id)),
    blocked_exit_ids: building.exits
      .filter((exit) => blocked.has(exit.id))
      .map((exit) => exit.id),
  };
}
