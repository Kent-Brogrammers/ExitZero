import { memo, useEffect, useMemo, useRef } from "react";
import type {
  AnimationFrame,
  BuildingScenario,
  ChatEvent,
  SimulationResult,
} from "../types/simulation";
import { formatLength } from "../utils/units";
import { useDisplayUnits } from "../utils/useDisplayUnits";
import { communicationMessage } from "./communication";
import { injuryLabel } from "./agentInspection";

const NO_EVENTS: readonly ChatEvent[] = [];

export const AgentPicker = memo(function AgentPicker({
  ids,
  selected,
  onSelect,
}: {
  ids: readonly number[];
  selected: number | null;
  onSelect: (id: number | null) => void;
}) {
  return (
    <label className="agent-picker">
      Inspect agent
      <select
        className="studio-control"
        aria-label="Inspect agent"
        value={selected ?? ""}
        disabled={!ids.length}
        onChange={(event) =>
          onSelect(
            event.target.value === "" ? null : Number(event.target.value),
          )
        }
      >
        <option value="">Click an occupant…</option>
        {ids.map((id) => (
          <option key={id} value={id}>
            Agent {id + 1}
          </option>
        ))}
      </select>
    </label>
  );
});

export function AgentInspector({
  id,
  building,
  frame,
  result,
  events = NO_EVENTS,
  live,
  onClose,
}: {
  id: number;
  building: BuildingScenario;
  frame: AnimationFrame | null;
  result?: SimulationResult | null;
  events?: readonly ChatEvent[];
  live?: boolean;
  onClose: () => void;
}) {
  useDisplayUnits();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current?.focus({ preventScroll: true }), [id]);
  const statistics = result?.analytics?.agents.find((agent) => agent.id === id);
  const timeStep = result?.time_step_seconds ?? building.time_step_seconds;
  const step = frame?.step ?? -1;
  const agent = frame?.agents.find((agent) => agent.id === id);
  const personalEvents = useMemo(
    () =>
      [
        ...(result?.agent_events ?? []),
        ...(result?.communication_events ?? []),
        ...(result?.frames.at(-1)?.pursuit?.events ?? []),
        ...events,
      ]
        .filter((event) =>
          "agent_id" in event
            ? event.agent_id === id
            : event.sender_id === id || event.recipient_ids.includes(id),
        )
        .sort((a, b) => a.step - b.step),
    [result, events, id],
  );
  const visibleEvents = personalEvents.filter((event) => event.step <= step);
  const latestRoute = visibleEvents.findLast(
    (event) =>
      "kind" in event &&
      [
        "heading_to_exit",
        "rerouting",
        "window_approach",
        "route_unavailable",
      ].includes(event.kind),
  );
  const destination =
    latestRoute && "kind" in latestRoute ? latestRoute.subject_id : undefined;
  const destinationName = (id: string) =>
    [
      ...building.exits,
      ...(building.windows ?? []),
      ...(building.tornado_zones ?? []),
    ].find((opening) => opening.id === id)?.name ?? id;
  const caught = frame?.pursuit?.caught.some(
    (caught) => caught.agent_id === id,
  );
  const evacuated =
    (statistics?.evacuation_step != null &&
      statistics.evacuation_step <= step) ||
    visibleEvents.some(
      (event) => "kind" in event && event.kind === "evacuated",
    );
  const sheltered =
    (statistics?.shelter && statistics.shelter.step <= step) ||
    visibleEvents.some(
      (event) => "kind" in event && event.kind === "sheltered",
    );
  const window = frame?.window_states?.find(
    (window) =>
      window.traversing_agent_id === id || window.queue_agent_ids.includes(id),
  );
  const status = caught
    ? "Caught"
    : sheltered
      ? "Sheltered"
      : evacuated
        ? "Evacuated"
        : window?.traversing_agent_id === id
          ? "Traversing window"
          : window
            ? "Queued at window"
            : agent
              ? "In simulation"
              : "Not present in this frame";
  return (
    <aside
      ref={panel}
      className="agent-inspector"
      aria-label={`Agent ${id + 1} inspector`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="control-popover-heading">
        <h3>Agent {id + 1}</h3>
        <button
          type="button"
          className="studio-control studio-control--icon"
          aria-label="Close agent inspector"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {building.placed_occupants?.[id]?.name && (
        <p className="agent-inspector-name">
          {building.placed_occupants[id]!.name}
        </p>
      )}
      <div className="agent-inspector-body">
        <h4>{live ? "Latest received sample" : "At the playhead"}</h4>
        <dl className="summary-values">
          <div>
            <dt>Simulation time</dt>
            <dd>
              {step >= 0 ? `${(step * timeStep).toFixed(2)} s` : "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{status}</dd>
          </div>
          <div>
            <dt>Position (x, y)</dt>
            <dd>
              {agent
                ? `${formatLength(agent.x)}, ${formatLength(agent.y)}`
                : "Not in frame"}
            </dd>
          </div>
          <div>
            <dt>Injury level</dt>
            <dd>{agent ? injuryLabel(agent.injury) : "Not in frame"}</dd>
          </div>
          <div>
            <dt>Last reported destination</dt>
            <dd>
              {destination
                ? destinationName(destination)
                : latestRoute
                  ? "No known route"
                  : "Not recorded"}
            </dd>
          </div>
        </dl>
        <div className="agent-path-key" aria-label="Agent path legend">
          <span className="agent-path-walked">Walked path</span>
          <span className="agent-path-planned">Desired path</span>
        </div>
        <p className="note">
          Walked path: sampled movement{" "}
          {live
            ? "since selection (up to 2,000 recent samples)"
            : "through the playhead"}
          . Gaps and barrier-crossing joins are omitted.
        </p>
        <p className="note">
          Desired path:{" "}
          {!agent
            ? live
              ? "this agent is no longer active in the latest frame."
              : "this agent is not active at this point. Rewind to inspect its plan."
            : agent.planned_path
              ? agent.planned_path.waypoints.length
                ? agent.planned_path.continues
                  ? "first 16 remaining waypoints; the route continues beyond the shown segment."
                  : "current route from the Rust engine."
                : "no current planned route."
              : "not recorded at this point; rerun the simulation to capture it."}
          {agent?.planned_path &&
            " This is the plan at this sample, based on the agent's knowledge. It can change as blockages or hazards are discovered; it is not a guaranteed future trajectory."}
        </p>
        <h4>Full-run statistics</h4>
        {statistics ? (
          <>
            <p className="note">
              Final totals for this recording, including movement after the
              playhead.
            </p>
            <dl className="summary-values">
              <div>
                <dt>Distance travelled</dt>
                <dd>{formatLength(statistics.distance_metres)}</dd>
              </div>
              <div>
                <dt>Collision waiting</dt>
                <dd>{statistics.waiting_seconds.toFixed(2)} s</dd>
              </div>
              <div>
                <dt>Time in simulation</dt>
                <dd>{statistics.elapsed_seconds.toFixed(2)} s</dd>
              </div>
              <div>
                <dt>Hazard exposure</dt>
                <dd>
                  {statistics.exposure_seconds != null
                    ? `${statistics.exposure_seconds.toFixed(2)} s`
                    : "Not recorded"}
                </dd>
              </div>
              <div>
                <dt>Evacuated at</dt>
                <dd>
                  {statistics.evacuation_seconds != null
                    ? `${statistics.evacuation_seconds.toFixed(2)} s`
                    : "Did not evacuate"}
                </dd>
              </div>
              {statistics.exit_id && (
                <div>
                  <dt>Exit used</dt>
                  <dd>{destinationName(statistics.exit_id)}</dd>
                </div>
              )}
              {statistics.shelter && (
                <div>
                  <dt>Sheltered at</dt>
                  <dd>
                    {statistics.shelter.seconds.toFixed(2)} s ·{" "}
                    {destinationName(statistics.shelter.id)}
                  </dd>
                </div>
              )}
              <div>
                <dt>Final route search</dt>
                <dd>
                  {statistics.route_found ? "Route found" : "No route found"}
                </dd>
              </div>
            </dl>
            <p className="note">
              A failed personal route search does not prove entrapment. Injury
              is an illustrative simulation measure.
            </p>
          </>
        ) : (
          <p className="note">
            {live
              ? "Final statistics are available after the run finishes."
              : "Per-agent statistics were not recorded for this simulation."}
          </p>
        )}
        <h4>Recent activity</h4>
        {visibleEvents.length ? (
          <ol
            className="agent-inspector-events"
            aria-label="Selected agent activity"
          >
            {visibleEvents.slice(-5).map((event, index) => (
              <li key={`${event.step}:${index}`}>
                <time>{(event.step * timeStep).toFixed(2)} s</time>
                <p>{communicationMessage(event, building)}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="note">No recorded activity at this point.</p>
        )}
      </div>
    </aside>
  );
}
