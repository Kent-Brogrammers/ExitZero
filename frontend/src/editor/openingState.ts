import type { BuildingScenario } from "../types/simulation";

/** Configured initial state only; physical collision remains the engine's job. */
export function openingStartsBlocked(building: BuildingScenario, id: string) {
  return (
    building.opening_events?.find(
      (event) => event.step === 0 && event.opening_id === id,
    )?.blocked ?? building.blocked_exit_ids.includes(id)
  );
}

/** Edit initial state without touching later schedules, stable IDs or geometry. */
export function setOpeningBlocked(
  building: BuildingScenario,
  kind: "doors" | "exits",
  id: string,
  blocked: boolean,
): BuildingScenario {
  if (!building[kind].some((opening) => opening.id === id)) return building;
  const events = (building.opening_events ?? []).filter(
    (event) => event.step !== 0 || event.opening_id !== id,
  );
  // A door is open by default. Its only added initial event is a closure.
  if (kind === "doors" && blocked)
    events.unshift({ step: 0, opening_id: id, blocked: true });
  return {
    ...building,
    blocked_exit_ids:
      kind === "exits"
        ? [
            ...building.blocked_exit_ids.filter((other) => other !== id),
            ...(blocked ? [id] : []),
          ]
        : building.blocked_exit_ids,
    ...(building.opening_events || events.length
      ? { opening_events: events }
      : {}),
  };
}
