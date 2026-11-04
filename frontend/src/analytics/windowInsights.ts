import type {
  AnimationFrame,
  BuildingScenario,
  WindowDecision,
  WindowDecisionHistory,
  WindowFrameState,
} from "../types/simulation";

export function windowDecisionIndex(history?: WindowDecisionHistory) {
  const agents = new Map<number, WindowDecision[]>();
  for (const choice of history?.choices ?? []) {
    const choices = agents.get(choice.agent_id) ?? [];
    choices.push(choice);
    agents.set(choice.agent_id, choices);
  }
  return {
    recorded: history !== undefined,
    truncated: history?.truncated ?? false,
    at(agent: number, step: number) {
      // Once recording reached its limit, a later omitted reassignment could
      // change the reason even for the same window. Do not reuse a stale belief.
      if (history?.truncated && step >= (history.choices.at(-1)?.step ?? 0))
        return undefined;
      const choices = agents.get(agent) ?? [];
      let low = 0,
        high = choices.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (choices[middle]!.step <= step) low = middle + 1;
        else high = middle;
      }
      return choices[low - 1];
    },
  };
}
export type WindowDecisionIndex = ReturnType<typeof windowDecisionIndex>;

export interface WindowEvidence {
  windowId: string;
  name: string;
  state: WindowFrameState["state"];
  step: number;
  waiting: number;
  crossing: number;
  approaching: number;
  assigned: number;
  faster: WindowDecision[];
  noKnownExit: number;
  unknown: number;
  comparisonsRecorded: boolean;
  truncated: boolean;
}

/** Attribution uses recorded assignments at this timestamp, never proximity. */
export function windowEvidence(
  building: BuildingScenario,
  frame: AnimationFrame,
  index: WindowDecisionIndex,
  eligible = new Set(frame.agents.map((agent) => agent.id)),
): WindowEvidence[] {
  const windows = new Map(
    (building.windows ?? []).map((window) => [window.id, window]),
  );
  return (frame.window_states ?? []).flatMap((state) => {
    const waiting = state.queue_agent_ids.filter((id) => eligible.has(id));
    const crossing =
      state.traversing_agent_id !== null &&
      eligible.has(state.traversing_agent_id)
        ? [state.traversing_agent_id]
        : [];
    const approaching = (state.approaching_agent_ids ?? []).filter((id) =>
      eligible.has(id),
    );
    const assigned = new Set([...waiting, ...crossing, ...approaching]);
    if (assigned.size === 0) return [];
    const faster: WindowDecision[] = [];
    let noKnownExit = 0,
      unknown = 0;
    for (const id of assigned) {
      const choice = index.at(id, frame.step);
      if (!choice || choice.window_id !== state.window_id) unknown++;
      else if (choice.reason === "estimated_faster") faster.push(choice);
      else if (choice.reason === "no_known_safe_exit") noKnownExit++;
      else unknown++;
    }
    return [
      {
        windowId: state.window_id,
        name: windows.get(state.window_id)?.name ?? `Window ${state.window_id}`,
        state: state.state,
        step: frame.step,
        waiting: waiting.length,
        crossing: crossing.length,
        approaching: approaching.length,
        assigned: assigned.size,
        faster,
        noKnownExit,
        unknown,
        comparisonsRecorded: index.recorded,
        truncated: index.truncated,
      },
    ];
  });
}

export function classifyWindowCrowding(
  evidence: WindowEvidence[],
  occupants: number,
) {
  const assigned = evidence.reduce(
    (count, window) => count + window.assigned,
    0,
  );
  if (assigned === 0) return null;
  if (assigned < occupants) return "Window users sharing a crowded area";
  return evidence.some((window) => window.waiting > 0)
    ? "Window escape queue"
    : evidence.some((window) => window.crossing > 0)
      ? "Window traversal activity"
      : "Converging on window escape";
}

/** Keep a peak for each window even when its queue is outside the three busiest zones. */
export function recordedWindowPeaks(frames: AnimationFrame[]) {
  const peaks = new Map<string, { frame: AnimationFrame; waiting: number }>();
  for (const frame of frames) {
    for (const state of frame.window_states ?? []) {
      if (
        state.queue_agent_ids.length +
          Number(state.traversing_agent_id !== null) <
        2
      )
        continue;
      const previous = peaks.get(state.window_id);
      if (state.queue_agent_ids.length > (previous?.waiting ?? 0)) {
        peaks.set(state.window_id, {
          frame,
          waiting: state.queue_agent_ids.length,
        });
      }
    }
  }
  return [...peaks].sort(
    (a, b) =>
      b[1].waiting - a[1].waiting ||
      a[1].frame.step - b[1].frame.step ||
      a[0].localeCompare(b[0]),
  );
}
