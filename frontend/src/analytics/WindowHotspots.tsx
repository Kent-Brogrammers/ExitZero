import { useMemo } from "react";
import type { BuildingScenario, SimulationResult } from "../types/simulation";
import {
  recordedWindowPeaks,
  windowDecisionIndex,
  windowEvidence,
  type WindowEvidence,
} from "./windowInsights";
import "./crowding.css";

function range(values: number[]) {
  const min = Math.min(...values),
    max = Math.max(...values);
  return min === max
    ? `${min.toFixed(1)} s`
    : `${min.toFixed(1)}–${max.toFixed(1)} s`;
}
const occupants = (n: number) => `${n} ${n === 1 ? "occupant" : "occupants"}`;

export function WindowExplanation({ evidence }: { evidence: WindowEvidence }) {
  const {
    faster,
    noKnownExit,
    unknown,
    waiting,
    crossing,
    approaching,
    name,
    state,
  } = evidence;
  const preparing =
    waiting > 0 && (state === "opening" || state === "breaking");
  return (
    <div className="window-explanation">
      <h4>{name}</h4>
      <p className="window-evidence">
        {waiting} waiting · {crossing} crossing · {approaching} approaching
        {preparing &&
          (state === "breaking"
            ? " · Preparing by breaking the window"
            : " · Preparing to open the window")}
      </p>
      {faster.length > 0 && (
        <>
          <p>
            {occupants(faster.length)} expected using this window to be quicker
            than reaching a normal exit. At choice time: window{" "}
            {range(faster.map((choice) => choice.estimated_window_seconds))};{" "}
            normal exit{" "}
            {range(faster.map((choice) => choice.estimated_exit_seconds!))}.
          </p>
          <p>
            Consider clearer sightlines to normal exits, shorter exit
            approaches, or removing furniture that delays those routes.
          </p>
        </>
      )}
      {noKnownExit > 0 && (
        <>
          <p>
            {occupants(noKnownExit)} had no usable normal-exit route in their
            current plan when they chose this window.
          </p>
          <p>
            Consider restoring exit access and improving route visibility;
            inspect blocked doors, hazards, and furniture along normal exit
            routes.
          </p>
        </>
      )}
      {unknown > 0 && (
        <p>
          The route-choice comparison for {occupants(unknown)} is unavailable in
          this recording.{" "}
          {evidence.comparisonsRecorded &&
            "This explanation uses only recorded comparisons."}
        </p>
      )}
      {waiting > 0 && (
        <p>
          {preparing
            ? "The queue is waiting while the window is prepared."
            : "Window traversal serves one occupant at a time in this model."}{" "}
          Keep the holding area clear of through traffic and compare layout
          changes under the same starting conditions.
        </p>
      )}
      {faster.length > 0 && (
        <p className="note">
          These were the agents’ estimates when they chose the window. Later
          arrivals can change the queue and the actual time taken.
        </p>
      )}
    </div>
  );
}

export default function WindowHotspots({
  building,
  result,
  onViewInSimulation,
}: {
  building?: BuildingScenario;
  result: SimulationResult | null;
  onViewInSimulation?: (step: number) => void;
}) {
  const peaks = useMemo(() => {
    if (!building || !result) return [];
    const index = windowDecisionIndex(result.analytics?.window_decisions);
    return recordedWindowPeaks(result.frames)
      .slice(0, 6)
      .flatMap(([id, peak]) =>
        windowEvidence(building, peak.frame, index).filter(
          (window) => window.windowId === id,
        ),
      );
  }, [building, result]);
  if (
    !building ||
    !result ||
    !building.windows?.length ||
    result.width !== building.width ||
    result.height !== building.height
  )
    return null;
  const recorded = result.frames.some(
    (frame) => frame.window_states !== undefined,
  );
  return (
    <section
      className="panel window-hotspots-panel"
      aria-label="Window queue insights"
    >
      <h2>Why people gathered at windows</h2>
      <p className="note">
        Up to six largest window queues in recorded frames, including queues
        close to spawn positions. The heatmap measures accumulated delay; these
        cards explain the occupants assigned to each window at the recorded
        peak.
      </p>
      {peaks.length ? (
        <div className="window-hotspot-cards">
          {peaks.map((window) => (
            <article className="window-hotspot-card" key={window.windowId}>
              <h3>
                Window escape queue ·{" "}
                {(window.step * result.time_step_seconds).toFixed(2)} s
              </h3>
              <WindowExplanation evidence={window} />
              {onViewInSimulation && (
                <button
                  type="button"
                  onClick={() => onViewInSimulation(window.step)}
                  aria-label={`View ${window.name} queue in simulation at ${(window.step * result.time_step_seconds).toFixed(2)} seconds`}
                >
                  View queue in simulation ↗
                </button>
              )}
            </article>
          ))}
        </div>
      ) : (
        <p className="note">
          {recorded
            ? "No multi-person window queue was recorded."
            : "Window queue data is unavailable for this recording."}
        </p>
      )}
      {result.analytics?.window_decisions?.truncated && (
        <p className="note">
          Some later route-choice comparisons were not retained. Only recorded
          comparisons are used above.
        </p>
      )}
    </section>
  );
}
