import type { AnimationFrame, SimulationResult } from "../types/simulation";

/** Direct recorded outcomes; caught survivors are never inferred as escaped. */
export function PursuitMetrics({
  frame,
  final = false,
}: {
  frame: AnimationFrame;
  final?: boolean;
}) {
  const pursuit = frame.pursuit;
  if (!pursuit) return null;
  return (
    <>
      <div>
        <dt>Escaped</dt>
        <dd>{pursuit.escaped}</dd>
      </div>
      <div>
        <dt>Caught</dt>
        <dd>{pursuit.caught.length}</dd>
      </div>
      <div>
        <dt>Remaining</dt>
        <dd>{frame.agents.length}</dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd>
          {!frame.agents.length
            ? "Pursuit finished"
            : final
              ? "Step limit reached"
              : "Surviving"}
        </dd>
      </div>
    </>
  );
}

export function PursuitReport({
  result,
  onReplay,
}: {
  result: SimulationResult;
  onReplay: () => void;
}) {
  const frame = result.frames.at(-1);
  if (!frame?.pursuit) return null;
  return (
    <section className="pursuit-report" aria-label="Halloween pursuit outcomes">
      <h3>Halloween — The Pursuit</h3>
      <p>
        {result.total_population} survivors ·{" "}
        {(frame.step * result.time_step_seconds).toFixed(2)} s · real seeded
        Rust simulation
      </p>
      <dl className="playback-readout">
        <PursuitMetrics frame={frame} final />
      </dl>
      <p>
        Fictional game scenario. Caught survivors leave active movement. The
        ordinary evacuation total of non-evacuated occupants includes caught
        survivors; the counts above separate them.
      </p>
      <p>
        Safety stress testing and optimization apply to ordinary evacuation
        modes. Replay this recording to review the pursuit.
      </p>
      <button type="button" className="studio-control" onClick={onReplay}>
        Review recording
      </button>
    </section>
  );
}
