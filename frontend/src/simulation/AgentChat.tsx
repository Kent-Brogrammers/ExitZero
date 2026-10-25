import { useEffect, useRef } from "react";
import type {
  AnimationFrame,
  BuildingScenario,
  SimulationResult,
} from "../types/simulation";
import {
  communicationsAtTime,
  communicationMessage,
  communicationTime,
} from "./communication";

export function AgentChat({
  building,
  result,
  time,
  liveFrame,
  onClose,
}: {
  building: BuildingScenario;
  result: SimulationResult | null;
  time: number;
  liveFrame?: AnimationFrame | null;
  onClose: () => void;
}) {
  const pursuitEvents =
    liveFrame?.pursuit?.events ?? result?.frames.at(-1)?.pursuit?.events;
  const timeStep = result?.time_step_seconds ?? building.time_step_seconds;
  const visible = communicationsAtTime(result, time, pursuitEvents, timeStep);
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
      {!result?.communication_events && !pursuitEvents ? (
        <p className="note">
          Communications were not recorded for this simulation.
        </p>
      ) : !visible.total ? (
        <p className="note">
          {result?.communication_events?.length || pursuitEvents?.length
            ? "No messages at this point in the recording."
            : pursuitEvents
              ? "No killer sightings or warnings were recorded."
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
                key={`${event.step}:${event.event_type ?? "shared"}:${event.sender_id}:${"opening_id" in event ? event.opening_id : "killer"}`}
              >
                <time>{communicationTime(event.step * timeStep)}</time>
                <p>{communicationMessage(event, building)}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}
