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
    // Keep symbols and IDs for closed doors. This display-only snapshot replaces
    // initial events with the recorded state so a reopened door is never hidden
    // by its original step-zero closure.
    opening_events: [
      ...building.doors
        .filter((door) => blocked.has(door.id))
        .map((door) => ({
          step: 0,
          opening_id: door.id,
          blocked: true,
        })),
      ...(building.opening_events ?? []).filter((event) => event.step > 0),
    ],
    blocked_exit_ids: building.exits
      .filter((exit) => blocked.has(exit.id))
      .map((exit) => exit.id),
  };
}
