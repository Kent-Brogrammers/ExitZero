import type {
  BuildingScenario,
  SimulationResult,
  CommunicationEvent,
} from "../types/simulation";

/** The recording is chronological. Keep the activity panel small while seeking. */
export function communicationsAtTime(
  result: SimulationResult | null,
  time: number,
) {
  const events = result?.communication_events ?? [];
  const step =
    result && Number.isFinite(time) ? time / result.time_step_seconds : -1;
  let low = 0,
    high = events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (events[middle]!.step <= step + 1e-8) low = middle + 1;
    else high = middle;
  }
  return { events: events.slice(Math.max(0, low - 200), low), total: low };
}

export function communicationTime(seconds: number) {
  const ticks = Math.round(seconds * 100);
  const minutes = Math.floor(ticks / 6000),
    wholeSeconds = Math.floor(ticks / 100) % 60,
    fraction = ticks % 100;
  return `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}${fraction ? `.${String(fraction).padStart(2, "0")}` : ""}`;
}

export function communicationMessage(
  event: CommunicationEvent,
  building: BuildingScenario,
) {
  const opening = [...building.doors, ...building.exits].find(
    (o) => o.id === event.opening_id,
  );
  const kind = building.exits.some((o) => o.id === event.opening_id)
    ? "Exit"
    : "Door";
  const label = opening?.name ?? `${kind} ${event.opening_id}`;
  if (event.event_type === "discovery")
    return `Agent ${event.sender_id + 1} discovered that ${label} is ${event.blocked ? "blocked" : "open"}.`;
  const numbers = event.recipient_ids.map((id) => String(id + 1));
  const recipients =
    numbers.length === 1
      ? `Agent ${numbers[0]}`
      : `Agents ${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
  return `Agent ${event.sender_id + 1} told ${recipients} that ${label} is ${event.blocked ? "blocked" : "open"}.`;
}
