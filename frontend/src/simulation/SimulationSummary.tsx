import type { SimulationResult } from "../types/simulation";

interface SimulationSummaryProps {
  result: SimulationResult | null;
  synthetic: boolean;
  playheadTime: number | null;
  onClose: () => void;
  onOpenAnalytics?: () => void;
}

/** Read-only fields from the exact recording in playback; no inferred population counts. */
export function SimulationSummary({
  result,
  synthetic,
  playheadTime,
  onClose,
  onOpenAnalytics,
}: SimulationSummaryProps) {
  const runSeconds =
    result?.analytics?.simulated_seconds ??
    (result?.clearance_steps != null
      ? result.clearance_steps * result.time_step_seconds
      : null);
  return (
    <aside
      className="simulation-summary"
      id="simulation-summary"
      aria-label="Simulation analytics"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="control-popover-heading">
        <h3>Recording summary</h3>
        <button
          type="button"
          className="studio-control studio-control--icon"
          aria-label="Close simulation analytics"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className={`summary-source${synthetic ? " is-synthetic" : ""}`}>
        {synthetic
          ? "Synthetic playback fixture"
          : result
            ? "API recording"
            : "Awaiting results"}
      </p>
      {result ? (
        <>
          <div className="summary-playhead">
            <span>Playhead time</span>
            <strong>
              {playheadTime === null
                ? "Unavailable"
                : `${playheadTime.toFixed(2)} s`}
            </strong>
          </div>
          <h4>Final recorded outcome</h4>
          <dl className="summary-values">
            <div>
              <dt>Status</dt>
              <dd>
                {result.status === "completed"
                  ? "Completed"
                  : result.status === "timeout"
                    ? "Step limit reached"
                    : "Incomplete"}
              </dd>
            </div>
            <div>
              <dt>Total occupants</dt>
              <dd>{result.total_population}</dd>
            </div>
            <div>
              <dt>Evacuated</dt>
              <dd>{result.evacuated}</dd>
            </div>
            <div>
              <dt>Remaining</dt>
              <dd>{result.remaining}</dd>
            </div>
            {result.evacuated_by_route && (
              <>
                <div>
                  <dt>Via normal exits</dt>
                  <dd>{result.evacuated_by_route.normal_exit}</dd>
                </div>
                <div>
                  <dt>Via emergency windows</dt>
                  <dd>{result.evacuated_by_route.emergency_window}</dd>
                </div>
              </>
            )}
            <div>
              <dt>Trapped</dt>
              <dd>{result.trapped}</dd>
            </div>
            <div>
              <dt>Run simulation time</dt>
              <dd>
                {runSeconds === null
                  ? "Unavailable"
                  : `${runSeconds.toFixed(2)} s`}
              </dd>
            </div>
          </dl>
          <p className="summary-note">
            Trapped occupants are included in remaining. Counts describe the
            final outcome, not the playhead.
          </p>
          {runSeconds === null && (
            <p className="summary-note">
              The result does not include the full run time. The last animation
              sample may precede the end of the run.
            </p>
          )}
          {synthetic && (
            <p className="summary-note summary-warning">
              Scripted preview only. No simulation was run; these values belong
              to this separate fixture, not your edited building.
            </p>
          )}
        </>
      ) : (
        <div className="summary-empty">
          <p>No matching simulation result is available.</p>
          <p>Run Simulation to see final metrics.</p>
        </div>
      )}
      <a
        className="studio-control summary-report-link"
        href="#analytics"
        onClick={(event) => {
          if (onOpenAnalytics) {
            event.preventDefault();
            onOpenAnalytics();
          }
        }}
      >
        Open Analytics <span aria-hidden="true">↗</span>
      </a>
      {synthetic && (
        <p className="summary-note">
          Full Analytics shows API results, independently of this playback
          fixture.
        </p>
      )}
    </aside>
  );
}
