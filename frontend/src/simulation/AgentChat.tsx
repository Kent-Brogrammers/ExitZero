import { useEffect, useRef } from "react";
import type {
  AnimationFrame,
  BuildingScenario,
  LiveSimulation,
  SimulationResult,
} from "../types/simulation";
import {
  chatAtTime,
  appendChat,
  chatSummaryMessage,
  chatSummaryNote,
  CHAT_HISTORY_LIMIT,
  communicationTime,
} from "./communication";

export function AgentChat({
  building,
  result,
  time,
  liveChat,
  liveFrame,
  onClose,
}: {
  building: BuildingScenario;
  result: SimulationResult | null;
  time: number;
  liveChat?: LiveSimulation["chat"];
  liveFrame?: AnimationFrame | null;
  onClose: () => void;
}) {
  const timeStep = result?.time_step_seconds ?? building.time_step_seconds;
  const pursuitEvents =
    liveFrame?.pursuit?.events ?? result?.frames.at(-1)?.pursuit?.events;
  const visible =
    liveChat ??
    (liveFrame && pursuitEvents
      ? appendChat(
          undefined,
          pursuitEvents.filter((e) => e.step * timeStep <= time + 1e-8),
          timeStep,
        )
      : chatAtTime(result, time));
  const latest = visible.messages.at(-1);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [latest]);
  return (
    <aside className="agent-chat" aria-label="Agent chat" id="agent-chat">
      <div className="control-popover-heading">
        <h3>Agent chat</h3>
        <button
          type="button"
          className="studio-control studio-control--icon"
          aria-label="Hide Agent Chat"
          autoFocus={Boolean(liveChat)}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {!liveChat &&
      !pursuitEvents &&
      !result?.communication_events &&
      !result?.agent_events ? (
        <p className="note">
          Communications were not recorded for this simulation.
        </p>
      ) : !visible.total ? (
        <p className="note">
          {pursuitEvents
            ? pursuitEvents.length
              ? "No messages at this point in the recording."
              : "No killer sightings or warnings were recorded."
            : liveChat
              ? "Waiting for agent messages…"
              : (result?.communication_events?.length ?? 0) +
                  (result?.agent_events?.length ?? 0)
                ? "No messages at this point in the recording."
                : "No agent activity was recorded."}
        </p>
      ) : (
        <>
          {visible.total > CHAT_HISTORY_LIMIT && (
            <p className="note">
              Showing the latest {CHAT_HISTORY_LIMIT} callouts.
            </p>
          )}
          <ol
            ref={list}
            role="log"
            aria-label={
              liveChat ? "Live agent messages" : "Recorded agent messages"
            }
            aria-live="off"
          >
            {visible.messages.map((summary) => (
              <li key={`${summary.key}:${summary.event.step}`}>
                <time>
                  {communicationTime(summary.event.step * timeStep)}
                  {summary.last_step > summary.event.step &&
                    `–${communicationTime(summary.last_step * timeStep)}`}
                </time>
                <p>{chatSummaryMessage(summary, building)}</p>
                {chatSummaryNote(summary) && (
                  <p className="chat-message-note">
                    {chatSummaryNote(summary)}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}
