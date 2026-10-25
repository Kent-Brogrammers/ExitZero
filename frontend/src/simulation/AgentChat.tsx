import { useEffect, useRef } from "react";
import type {
  BuildingScenario,
  LiveSimulation,
  SimulationResult,
} from "../types/simulation";
import {
  chatAtTime,
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
  onClose,
}: {
  building: BuildingScenario;
  result: SimulationResult | null;
  time: number;
  liveChat?: LiveSimulation["chat"];
  onClose: () => void;
}) {
  const visible = liveChat ?? chatAtTime(result, time);
  const timeStep = result?.time_step_seconds ?? building.time_step_seconds;
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
      {!liveChat && !result?.communication_events && !result?.agent_events ? (
        <p className="note">
          Communications were not recorded for this simulation.
        </p>
      ) : !visible.total ? (
        <p className="note">
          {liveChat
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
