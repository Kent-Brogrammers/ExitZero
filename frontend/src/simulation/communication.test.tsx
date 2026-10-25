import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AgentChat } from "./AgentChat";
import {
  communicationMessage,
  communicationsAtTime,
  communicationTime,
} from "./communication";
import {
  syntheticBuilding as building,
  syntheticResult,
} from "./playback.fixture";
import type { CommunicationEvent } from "../types/simulation";

// Synthetic component fixtures only; no production messages are manufactured.
const events: CommunicationEvent[] = [
  {
    step: 5,
    sender_id: 0,
    recipient_ids: [1, 2],
    opening_id: "west",
    blocked: true,
  },
  {
    step: 20,
    sender_id: 2,
    recipient_ids: [5],
    opening_id: "west",
    blocked: true,
  },
  {
    step: 45,
    sender_id: 0,
    recipient_ids: [1, 2],
    opening_id: "west",
    blocked: false,
  },
];
const result = { ...syntheticResult, communication_events: events };

it("uses actual step times and removes future messages immediately when rewinding", () => {
  expect(communicationsAtTime(result, 0).events).toEqual([]);
  expect(communicationsAtTime(result, 0.5).events).toEqual([events[0]]);
  expect(communicationsAtTime(result, 2).events).toEqual(events.slice(0, 2));
  expect(communicationsAtTime(result, 4.5).events).toEqual(events);
  expect(communicationsAtTime(result, 0.5).events).toEqual([events[0]]);
  expect(communicationsAtTime(result, 0.49).events).toEqual([]);
  expect(communicationsAtTime(null, 5).events).toEqual([]);
});

it("uses stable ID numbers and names the actual opening in callouts", () => {
  expect(
    communicationMessage(
      { ...events[0]!, event_type: "discovery", recipient_ids: [] },
      building,
    ),
  ).toBe("Agent 1: “Don't head for Exit 1! It's blocked.”");
  expect(
    communicationMessage(
      { ...events[2]!, event_type: "discovery", recipient_ids: [] },
      building,
    ),
  ).toBe("Agent 1: “Exit 1 is open! Pass it on.”");
  expect(communicationMessage(events[0]!, building)).toBe(
    "Agent 1: “Hey, Exit 1 is blocked! Pass it on.”",
  );
  expect(communicationMessage(events[1]!, building)).toBe(
    "Agent 3: “Hey, Exit 1 is blocked! Pass it on.”",
  );
  expect(
    communicationMessage(events[2]!, {
      ...building,
      exits: building.exits.map((e) => ({ ...e, name: "West entrance" })),
    }),
  ).toBe("Agent 1: “West entrance is open! Pass it on.”");
  expect(communicationTime(65.25)).toBe("01:05.25");
  expect(communicationTime(4)).toBe("00:04");
});

it("keeps legacy, empty and awaiting-message states honest", () => {
  const chat = (recording: typeof syntheticResult | null, time = 0) =>
    renderToStaticMarkup(
      <AgentChat
        building={building}
        result={recording}
        time={time}
        onClose={() => {}}
      />,
    );
  expect(chat(syntheticResult)).toContain("Communications were not recorded");
  expect(chat(null)).toContain("Communications were not recorded");
  expect(chat({ ...syntheticResult, communication_events: [] })).toContain(
    "No agent activity was recorded",
  );
  expect(chat(result)).toContain("No messages at this point");
  const html = chat(result, 2);
  expect(html).toContain("00:00.50");
  expect(html).toContain("1 other person said the same");
  expect(html).toContain("Heard by 3 people");
  expect(html).not.toContain("is open");
});

it("groups discovery and sharing at the same actual timestamp and removes later recipients on rewind", () => {
  const discovery: CommunicationEvent = {
    ...events[0]!,
    event_type: "discovery",
    recipient_ids: [],
  };
  const recording = {
    ...result,
    communication_events: [
      discovery,
      { ...events[0]!, event_type: "shared" as const },
      events[1]!,
    ],
  };
  const chat = (time: number) =>
    renderToStaticMarkup(
      <AgentChat
        building={building}
        result={recording}
        time={time}
        onClose={() => {}}
      />,
    );
  expect(chat(0.49)).not.toContain("<li>");
  expect(chat(0.5).match(/<li>/g)).toHaveLength(1);
  expect(chat(0.5)).toContain("Heard by 2 people");
  expect(chat(2).match(/<li>/g)).toHaveLength(1);
  expect(chat(2)).toContain("Heard by 3 people");
  expect(chat(0.5)).not.toContain("Heard by 3 people");
});

it("limits rendered history while retaining the complete recording and correct seek prefix", () => {
  const many = {
    ...result,
    communication_events: Array.from({ length: 250 }, (_, step) => ({
      ...events[0]!,
      step,
    })),
  };
  const before = JSON.stringify(many);
  const visible = communicationsAtTime(many, 24.9);
  expect(visible.total).toBe(250);
  expect(visible.events).toHaveLength(200);
  expect(visible.events[0]!.step).toBe(50);
  expect(communicationsAtTime(many, 1).events).toHaveLength(11);
  expect(JSON.stringify(many)).toBe(before);
});
