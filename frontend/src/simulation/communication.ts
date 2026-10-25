import type {
  BuildingScenario,
  SimulationResult,
  AgentEvent,
  ChatEvent,
  ChatHistory,
  ChatSummary,
} from "../types/simulation";
import { objectName } from "../editor/names";

const histories = new WeakMap<
  SimulationResult,
  {
    shares: SimulationResult["communication_events"];
    activity: SimulationResult["agent_events"];
    events: ChatEvent[];
    summary?: { through: number; history: ChatHistory };
  }
>();

/** The recording is chronological. Keep the activity panel small while seeking. */
export function communicationsAtTime(
  result: SimulationResult | null,
  time: number,
) {
  let events: ChatEvent[] = [];
  if (result) {
    let cached = histories.get(result);
    if (
      !cached ||
      cached.shares !== result.communication_events ||
      cached.activity !== result.agent_events
    ) {
      cached = {
        shares: result.communication_events,
        activity: result.agent_events,
        events: [
          ...(result.communication_events ?? []),
          ...(result.agent_events ?? []),
        ].sort((a, b) => a.step - b.step),
      };
      histories.set(result, cached);
    }
    events = cached.events;
  }
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

const SUMMARY_SECONDS = 10;
export const CHAT_HISTORY_LIMIT = 80;

/** Rebuild on rewind so summaries never include people heard later in the run. */
export function chatAtTime(
  result: SimulationResult | null,
  time: number,
): ChatHistory {
  const { total } = communicationsAtTime(result, time);
  const cached = result ? histories.get(result) : undefined;
  if (!result || !cached) return { messages: [], total: 0 };
  if (!cached.summary || total < cached.summary.through)
    cached.summary = { through: 0, history: { messages: [], total: 0 } };
  if (total > cached.summary.through) {
    cached.summary.history = appendChat(
      cached.summary.history,
      cached.events.slice(cached.summary.through, total),
      result.time_step_seconds,
    );
    cached.summary.through = total;
  }
  return cached.summary.history;
}

function summaryKey(event: ChatEvent) {
  return "kind" in event
    ? JSON.stringify([
        event.kind,
        event.subject_id,
        event.hazard_kind,
        event.kind.startsWith("hazard_") && event.position
          ? [Math.floor(event.position.x / 3), Math.floor(event.position.y / 3)]
          : null,
      ])
    : JSON.stringify(["opening", event.opening_id, event.blocked]);
}

/** Fold new observations into bounded summaries without changing agent knowledge. */
export function appendChat(
  history: ChatHistory | undefined,
  events: readonly ChatEvent[],
  timeStep: number,
): ChatHistory {
  const messages = [...(history?.messages ?? [])];
  let total = history?.total ?? 0;
  const active = new Map<string, number>();
  function resetConflictingOpening(event: ChatEvent) {
    if (!("kind" in event)) {
      // A reopening or new closure is always a fresh update.
      for (const [otherKey, index] of active) {
        const other = messages[index]!.event;
        if (
          !("kind" in other) &&
          other.opening_id === event.opening_id &&
          other.blocked !== event.blocked
        )
          active.delete(otherKey);
      }
    }
  }
  messages.forEach((message, index) => {
    resetConflictingOpening(message.event);
    active.set(message.key, index);
  });
  for (const event of events) {
    const key = summaryKey(event);
    resetConflictingOpening(event);
    const index = active.get(key);
    const speaker = "kind" in event ? event.agent_id : event.sender_id;
    const recipients = "kind" in event ? [] : event.recipient_ids;
    if (
      index === undefined ||
      (event.step - messages[index]!.event.step) * timeStep >= SUMMARY_SECONDS
    ) {
      messages.push({
        key,
        event,
        last_step: event.step,
        agent_ids: [speaker],
        recipient_ids: [...new Set(recipients)],
      });
      active.set(key, messages.length - 1);
      total++;
    } else {
      const previous = messages[index]!;
      messages[index] = {
        ...previous,
        last_step: event.step,
        agent_ids: [...new Set([...previous.agent_ids, speaker])],
        recipient_ids: [...new Set([...previous.recipient_ids, ...recipients])],
      };
    }
  }
  return { messages: messages.slice(-CHAT_HISTORY_LIMIT), total };
}

export function chatSummaryMessage(
  summary: ChatSummary,
  building: BuildingScenario,
) {
  return communicationMessage(summary.event, building);
}

export function chatSummaryNote(summary: ChatSummary) {
  const others = summary.agent_ids.length - 1;
  return [
    others > 0
      ? `${others} ${others === 1 ? "other person said" : "others said"} the same`
      : "",
    summary.recipient_ids.length > 0
      ? `Heard by ${summary.recipient_ids.length} ${summary.recipient_ids.length === 1 ? "person" : "people"}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function communicationTime(seconds: number) {
  const ticks = Math.round(seconds * 100);
  const minutes = Math.floor(ticks / 6000),
    wholeSeconds = Math.floor(ticks / 100) % 60,
    fraction = ticks % 100;
  return `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}${fraction ? `.${String(fraction).padStart(2, "0")}` : ""}`;
}

function targetLabel(event: AgentEvent, building: BuildingScenario) {
  const kind = building.windows?.some(
    (window) => window.id === event.subject_id,
  )
    ? "windows"
    : building.tornado_zones?.some((zone) => zone.id === event.subject_id)
      ? "tornado_zones"
      : "exits";
  return event.subject_id
    ? objectName(building, { kind, id: event.subject_id })
    : "the exit";
}

/** Callouts use only the recorded observation; no invented replies or outcomes. */
export function communicationMessage(
  event: ChatEvent,
  building: BuildingScenario,
) {
  if ("kind" in event) {
    const label = targetLabel(event, building);
    const danger =
      event.hazard_kind === "gas_leak"
        ? "gas"
        : event.hazard_kind === "tornado"
          ? "a tornado"
          : (event.hazard_kind ?? "something dangerous");
    const nearExit = event.position
      ? building.exits.find((exit) => {
          const wall = building.walls.find((wall) => wall.id === exit.wall_id);
          if (!wall) return false;
          const length = Math.hypot(
            wall.end.x - wall.start.x,
            wall.end.y - wall.start.y,
          );
          if (!length) return false;
          const t = (exit.offset + exit.width / 2) / length;
          const x = wall.start.x + (wall.end.x - wall.start.x) * t;
          const y = wall.start.y + (wall.end.y - wall.start.y) * t;
          return Math.hypot(x - event.position!.x, y - event.position!.y) <= 4;
        })
      : undefined;
    const place = nearExit
      ? ` near ${objectName(building, { kind: "exits", id: nearExit.id })}`
      : " over there";
    const messages: Record<AgentEvent["kind"], string[]> = {
      heading_to_exit: [`I'm going for ${label}!`, `Let's try ${label}.`],
      hazard_discovered: [
        `There's ${danger}${place}! Stay back.`,
        `Watch out for ${danger}${place}!`,
      ],
      hazard_spreading:
        event.hazard_kind === "tornado"
          ? ["That tornado's moving! Keep away from it."]
          : [
              `The ${danger} is spreading! We need to move.`,
              `It's getting worse${place}. Don't hang around!`,
            ],
      rerouting: [
        `I'm trying ${label} instead.`,
        `Change of plan. I'm heading for ${label}!`,
      ],
      route_unavailable: [
        "I can't find a way out. Anyone know another way?",
        "I can't get through. Where else can we go?",
      ],
      window_approach: [
        `Maybe we can get out through ${label}!`,
        `I'm going to try ${label}.`,
      ],
      window_queue: [
        `I'm waiting to get through ${label}.`,
        `Let me know when it's my turn at ${label}!`,
      ],
      window_opening: [`I'll get ${label} open!`],
      window_breaking: [`Stand back! I'm breaking ${label} so we can get out.`],
      window_traversal: [`I'm climbing through ${label}!`],
      exposure:
        event.hazard_kind === "gas_leak"
          ? ["I'm breathing in gas! I need to get away from here."]
          : event.hazard_kind === "fire"
            ? ["It's too hot here! I need to move."]
            : ["I need to get away from this!"],
      waiting: [
        "Can you give me some room? I can't move!",
        "I'm stuck here. Let me through!",
      ],
      evacuated: [
        `I made it out through ${label}!`,
        `I'm out! I used ${label}.`,
      ],
      sheltered: [`I made it to ${label}. I'm staying here.`],
    };
    const choices = messages[event.kind];
    const words = choices[(event.agent_id * 31 + event.step) % choices.length];
    return `Agent ${event.agent_id + 1}: “${words}”`;
  }
  const kind = building.exits.some((opening) => opening.id === event.opening_id)
    ? "exits"
    : "doors";
  const label = objectName(building, { kind, id: event.opening_id });
  const words = event.blocked
    ? event.event_type === "discovery"
      ? `Don't head for ${label}! It's blocked.`
      : `Hey, ${label} is blocked! Pass it on.`
    : `${label} is open! Pass it on.`;
  return `Agent ${event.sender_id + 1}: “${words}”`;
}
