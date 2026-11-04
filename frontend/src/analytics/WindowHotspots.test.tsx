// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  AnimationFrame,
  SimulationResult,
  WindowDecision,
} from "../types/simulation";
import {
  syntheticBuilding,
  syntheticResult,
} from "../simulation/playback.fixture";
import WindowHotspots from "./WindowHotspots";
import CrowdingRanking from "./CrowdingRanking";
import {
  classifyWindowCrowding,
  recordedWindowPeaks,
  windowDecisionIndex,
  windowEvidence,
} from "./windowInsights";

const building = {
  ...syntheticBuilding,
  windows: [
    {
      id: "pane",
      name: "East sash",
      wall_id: "east-wall",
      offset: 0.5,
      width: 1,
    },
  ],
};
const choice = (agent: number, step: number): WindowDecision => ({
  agent_id: agent,
  step,
  window_id: "pane",
  reason: "estimated_faster",
  estimated_window_seconds: 8 + agent * 3,
  estimated_exit_seconds: 20,
});
function result(): SimulationResult {
  const agents = [
    { id: 0, x: 3.2, y: 1.1 },
    { id: 1, x: 3.6, y: 1.4 },
  ];
  return {
    ...syntheticResult,
    status: "incomplete",
    evacuated: 0,
    remaining: 2,
    clearance_steps: null,
    frames: [
      { step: 0, agents },
      {
        step: 50,
        agents,
        window_states: [
          {
            window_id: "pane",
            state: "breaking",
            preparation_ready_step: 80,
            queue_agent_ids: [0, 1],
            traversing_agent_id: null,
            traversal_earliest_finish_step: null,
            approaching_agent_ids: [],
          },
        ],
      },
    ],
    analytics: {
      simulated_seconds: 5,
      median_evacuation_seconds: null,
      total_distance_metres: 0,
      total_waiting_seconds: 0,
      agents: agents.map(({ id }) => ({
        id,
        distance_metres: 0,
        waiting_steps: 0,
        waiting_seconds: 0,
        elapsed_seconds: 5,
        evacuation_step: null,
        evacuation_seconds: null,
        exit_id: null,
        route_found: true,
      })),
      window_decisions: {
        choices: [choice(0, 0), choice(1, 1)],
        truncated: false,
      },
    },
  };
}

describe("window hotspot evidence", () => {
  it("explains actual faster-window choices and preparation queues even beside a spawn", () => {
    const data = result();
    const html = renderToStaticMarkup(
      <WindowHotspots building={building} result={data} />,
    );
    expect(html).toContain("East sash");
    expect(html).toContain("2 waiting");
    expect(html).toContain("expected using this window to be quicker");
    expect(html).toContain("8.0–11.0 s");
    expect(html).toContain("20.0 s");
    expect(html).toContain("window is prepared");
    expect(html).toContain("clearer sightlines to normal exits");
    const crowded = renderToStaticMarkup(
      <CrowdingRanking building={building} result={data} />,
    );
    expect(crowded).toContain("Window escape queue");
    expect(crowded).toContain("2 occupants together");
  });

  it("distinguishes fallback from preference and does not borrow future decisions", () => {
    const data = result();
    data.analytics!.window_decisions!.choices[1] = {
      ...choice(1, 1),
      reason: "no_known_safe_exit",
      estimated_exit_seconds: null,
    };
    data.analytics!.window_decisions!.choices.push({
      ...choice(0, 51),
      reason: "no_known_safe_exit",
      estimated_exit_seconds: null,
    });
    data.frames.push({
      ...data.frames[1]!,
      step: 100,
      window_states: [
        {
          ...data.frames[1]!.window_states![0]!,
          state: "broken",
          queue_agent_ids: [0],
          traversing_agent_id: 1,
          traversal_earliest_finish_step: 110,
        },
      ],
    });
    data.analytics!.simulated_seconds = 10;
    data.analytics!.agents.forEach((agent) => {
      agent.elapsed_seconds = 10;
    });
    const evidence = windowEvidence(
      building,
      data.frames[1]!,
      windowDecisionIndex(data.analytics!.window_decisions),
    )[0]!;
    expect(evidence.faster).toHaveLength(1);
    expect(evidence.noKnownExit).toBe(1);
    const html = renderToStaticMarkup(
      <WindowHotspots building={building} result={data} />,
    );
    expect(html).toContain("1 occupant expected using this window");
    expect(html).toContain("1 occupant had no usable normal-exit route");
    expect(html).toContain("restoring exit access");
  });

  it("does not attribute nearby unrelated occupants to window use", () => {
    const data = result();
    const frame = {
      ...data.frames[1]!,
      agents: [...data.frames[1]!.agents, { id: 2, x: 3.4, y: 1.3 }],
    };
    const index = windowDecisionIndex(data.analytics!.window_decisions);
    expect(windowEvidence(building, frame, index, new Set([2]))).toEqual([]);
    expect(classifyWindowCrowding([], 1)).toBeNull();
    const mixed = windowEvidence(building, frame, index, new Set([0, 2]));
    expect(mixed[0]!.assigned).toBe(1);
    expect(classifyWindowCrowding(mixed, 2)).toBe(
      "Window users sharing a crowded area",
    );
  });

  it("keeps legacy and truncated comparisons uncertain instead of inventing beliefs", () => {
    const data = result();
    delete data.analytics!.window_decisions;
    let html = renderToStaticMarkup(
      <WindowHotspots building={building} result={data} />,
    );
    expect(html).toContain(
      "route-choice comparison for 2 occupants is unavailable",
    );
    expect(html).not.toContain("expected using this window");
    data.analytics!.window_decisions = {
      choices: [choice(0, 0), choice(1, 1)],
      truncated: true,
    };
    html = renderToStaticMarkup(
      <WindowHotspots building={building} result={data} />,
    );
    expect(html).not.toContain("expected using this window");
    expect(html).toContain(
      "Some later route-choice comparisons were not retained",
    );
  });

  it("finds a window queue peak independently of zone rankings", () => {
    const frame = result().frames[1]!;
    const later: AnimationFrame = {
      ...frame,
      step: 90,
      window_states: [
        {
          ...frame.window_states![0]!,
          queue_agent_ids: [0],
          traversing_agent_id: 1,
          traversal_earliest_finish_step: 95,
          state: "broken",
        },
      ],
    };
    expect(recordedWindowPeaks([frame, later])[0]![1].frame.step).toBe(50);
  });

  it("opens the recorded peak step rather than its frame-array index", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const view = vi.fn();
    try {
      await act(async () =>
        root.render(
          <WindowHotspots
            building={building}
            result={result()}
            onViewInSimulation={view}
          />,
        ),
      );
      await act(async () => host.querySelector("button")!.click());
      expect(view).toHaveBeenCalledWith(50);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
