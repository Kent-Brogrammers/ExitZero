import { useEffect, useRef } from "react";
import type { BuildingScenario, SimulationResult } from "../types/simulation";
import {
  communicationsAtTime,
  communicationMessage,
  communicationTime,
} from "./communication";

export function AgentChat({
  building,
  result,
  time,
  onClose,
}: {
  building: BuildingScenario;
  result: SimulationResult | null;
  time: number;
  onClose: () => void;
}) {
  const visible = communicationsAtTime(result, time);
  const latest = visible.events.at(-1);
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
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {!result?.communication_events ? (
        <p className="note">
          Communications were not recorded for this simulation.
        </p>
      ) : !visible.total ? (
        <p className="note">
          {result.communication_events.length
            ? "No messages at this point in the recording."
            : "No new opening information was recorded."}
        </p>
      ) : (
        <>
          {visible.total > 200 && (
            <p className="note">
              Showing the latest 200 messages at this time.
            </p>
          )}
          <ol
            ref={list}
            role="log"
            aria-label="Recorded agent messages"
            aria-live="off"
          >
            {visible.events.map((event) => (
              <li
                key={`${event.step}:${event.event_type ?? "shared"}:${event.sender_id}:${event.opening_id}`}
              >
                <time>
                  {communicationTime(event.step * result.time_step_seconds)}
                </time>
                <p>{communicationMessage(event, building)}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}
