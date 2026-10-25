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
  return (
    <details className="window-readout">
      <summary>
        Window service ·{" "}
        {states.reduce((n, s) => n + s.queue_agent_ids.length, 0)} waiting ·{" "}
        {states.filter((s) => s.traversing_agent_id !== null).length} traversing
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
              {s.traversing_agent_id !== null
                ? ` · occupant ${s.traversing_agent_id} traversing`
                : ""}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
