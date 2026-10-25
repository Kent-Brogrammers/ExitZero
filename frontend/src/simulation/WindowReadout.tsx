import type { BuildingScenario, WindowFrameState } from "../types/simulation";

/** Only authoritative state at the playhead; never guesses evacuation from frames. */
export function WindowReadout({
  building,
  states,
}: {
  building: BuildingScenario;
  states?: readonly WindowFrameState[];
}) {
  if (!states?.length)
    return building.windows?.length ? (
      <p className="note">
        Window service state is unavailable in this recording.
      </p>
    ) : null;
  const hasApproachCounts = states.every(
    (s) => s.approaching_agent_ids !== undefined,
  );
  return (
    <details
      className="window-readout"
      open={states.some((s) => !!s.unavailable_reason)}
    >
      <summary>
        Window service ·{" "}
        {hasApproachCounts && (
          <>
            {states.reduce(
              (n, s) => n + (s.approaching_agent_ids?.length ?? 0),
              0,
            )}{" "}
            approaching ·{" "}
          </>
        )}
        {states.reduce((n, s) => n + s.queue_agent_ids.length, 0)} waiting ·{" "}
        {states.filter((s) => s.traversing_agent_id !== null).length} traversing
        {states.some((s) => !!s.unavailable_reason) &&
          ` · ${states.filter((s) => !!s.unavailable_reason).length} unavailable`}
      </summary>
      <p className="note">
        Amber rings: recorded queue members. Green rings: the active traverser.
        This shows the current recorded sample.
      </p>
      <dl className="playback-readout">
        {states.map((s) => (
          <div key={s.window_id}>
            <dt>
              {building.windows?.find((w) => w.id === s.window_id)?.name ??
                s.window_id}
            </dt>
            <dd>
              {s.state} · {s.queue_agent_ids.length} waiting
              {s.approaching_agent_ids !== undefined
                ? ` · ${s.approaching_agent_ids.length} approaching`
                : ""}
              {s.traversing_agent_id !== null
                ? ` · occupant ${s.traversing_agent_id} traversing`
                : ""}
              {s.unavailable_reason && (
                <p className="note">{s.unavailable_reason}</p>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
