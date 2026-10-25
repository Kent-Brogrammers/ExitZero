import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SimulationView } from "./SimulationView";
import {
  syntheticBuilding as building,
  syntheticResult as result,
} from "./playback.fixture";
import type { BuildingScenario, WindowFrameState } from "../types/simulation";

// Presentation fixtures only; actual simulation data is unchanged by the UI.
const withWindow: BuildingScenario = {
  ...building,
  windows: [
    { id: "pane", name: "East window", wall_id: "north", offset: 1, width: 1 },
  ],
};
const rejectedWindow: WindowFrameState = {
  window_id: "pane",
  state: "intact",
  preparation_ready_step: null,
  queue_agent_ids: [],
  traversing_agent_id: null,
  traversal_earliest_finish_step: null,
  unavailable_reason: "The indoor approach is blocked.",
};

function outsideDetails(html: string) {
  return html.replace(
    /<details class="simulation-details">.*?<\/details>/gs,
    "",
  );
}

describe("live first run and recorded review", () => {
  it("defaults both agent features off and keeps chat unavailable during a live run", () => {
    const html = renderToStaticMarkup(
      <SimulationView building={building} result={result} />,
    );
    expect(html).toContain("Show Agent Numbers");
    expect(html).toContain("Show Agent Chat");
    expect(html).not.toContain("checked=");
    expect(html).not.toContain('class="agent-chat"');
    const live = renderToStaticMarkup(
      <SimulationView
        building={building}
        result={null}
        live={{ frame: result.frames[0]! }}
      />,
    );
    expect(live).toMatch(
      /<input[^>]*disabled=""[^>]*aria-controls="agent-chat"/,
    );
    expect(live).not.toContain('class="agent-chat"');
  });
  it("shows a live run without a future duration or rewind controls", () => {
    const html = renderToStaticMarkup(
      <SimulationView
        building={building}
        result={null}
        live={{ frame: result.frames[1]! }}
      />,
    );
    expect(html).toContain("Live evacuation");
    expect(html).toMatch(/<canvas[^>]*data-world-canvas=/);
    expect(html).toContain("LIVE · RECORDING");
    expect(html).toContain("1.00 s");
    expect(html).toContain(
      "Rewind, replay and peak crowding snapshots are available after the run",
    );
    expect(html).not.toContain('type="range"');
    expect(html).not.toContain("(end)");
    expect(html).not.toContain("Recorded outcome");
  });

  it("opens the completed recording at its end so the user can rewind", () => {
    const html = renderToStaticMarkup(
      <SimulationView building={building} result={result} />,
    );
    expect(html).toContain("End of recording");
    expect(html).toMatch(/<canvas[^>]*data-world-canvas=/);
    expect(html).toContain("Replay");
    expect(html).toContain('type="range"');
    expect(html).toContain('max="4"');
    expect(html).toContain('value="4"');
    expect(html).toContain("8.00 s");
    expect(html).not.toContain("LIVE · RECORDING");
  });
  it("offers synthetic playback only when the current workspace permits it", () => {
    const standard = renderToStaticMarkup(
      <SimulationView building={building} result={null} />,
    );
    expect(standard).toContain(
      "No recording yet. Run Simulation or try the synthetic preview.",
    );
    const demo = renderToStaticMarkup(
      <SimulationView
        building={building}
        result={null}
        allowSyntheticPreview={false}
      />,
    );
    expect(demo).toContain("No recording yet. Run Simulation.");
    expect(demo).not.toContain("or try the synthetic preview");
    expect(demo).not.toContain("Recorded outcome");
  });

  it("distinguishes absent frames and layout mismatches from an unstarted run", () => {
    const empty = renderToStaticMarkup(
      <SimulationView building={building} result={{ ...result, frames: [] }} />,
    );
    expect(empty).toContain("No recorded frames. Playback is unavailable.");
    const mismatch = renderToStaticMarkup(
      <SimulationView
        building={building}
        result={{ ...result, width: result.width + 1 }}
      />,
    );
    expect(mismatch).toContain('role="alert"');
    expect(mismatch).toContain("dimensions do not match the current layout");
    expect(mismatch).not.toContain("Recorded outcome");
  });

  it("keeps window warnings and crowding inside one closed live Details panel", () => {
    const html = renderToStaticMarkup(
      <SimulationView
        building={withWindow}
        result={null}
        live={{
          frame: { ...result.frames[0]!, window_states: [rejectedWindow] },
        }}
      />,
    );
    expect(html.match(/<details /g)).toHaveLength(1);
    expect(html).toContain('<summary class="studio-control">Details</summary>');
    expect(html).not.toContain('open=""');
    expect(html).toContain(rejectedWindow.unavailable_reason);
    expect(html).toContain("Current busiest zone");
    const visible = outsideDetails(html);
    for (const label of [
      "Elapsed simulation time",
      "Evacuated",
      "Remaining",
      "Status",
    ])
      expect(visible).toContain(label);
    expect(visible).not.toContain("Window service");
    expect(visible).not.toContain("Current busiest zone");
    expect(visible).not.toContain("Colors show current positions");
    expect(visible).not.toContain(rejectedWindow.unavailable_reason);
  });

  it("keeps recorded controls and explicitly final outcomes visible, with secondary data collapsed", () => {
    const html = renderToStaticMarkup(
      <SimulationView
        building={withWindow}
        result={{
          ...result,
          frames: result.frames.map((f) => ({
            ...f,
            window_states: [rejectedWindow],
          })),
        }}
      />,
    );
    const visible = outsideDetails(html);
    for (const action of [
      "Replay",
      "Pause",
      "Reset",
      "Previous recorded frame",
      "Next recorded frame",
      "Playback speed",
      "Recording timeline",
      "Show Agent Chat",
      "Show Analytics",
    ])
      expect(visible).toContain(action);
    expect(visible).toContain("Evacuated (final)</dt><dd>2");
    expect(visible).toContain("Remaining (final)</dt><dd>0");
    expect(visible).toContain('Status (final)</dt><dd role="status">Completed');
    for (const extra of [
      "Recorded traffic trails",
      "Simulation step",
      "Recorded occupants",
      rejectedWindow.unavailable_reason!,
    ]) {
      expect(visible).not.toContain(extra);
      expect(html).toContain(extra);
    }
    expect(html.match(/<details /g)).toHaveLength(1);
    expect(html).not.toContain('open=""');
  });

  it("omits window service entirely for both live and recorded tornado response", () => {
    const tornado: BuildingScenario = {
      ...withWindow,
      disaster: { kind: "tornado", center: { x: 0, y: 0 }, radius: 0.1 },
    };
    const frame = {
      ...result.frames.at(-1)!,
      sheltered: 2,
      window_states: [
        {
          ...rejectedWindow,
          unavailable_reason: "Tornado response uses shelter zones.",
        },
      ],
    };
    const html = renderToStaticMarkup(
      <SimulationView
        building={tornado}
        result={{ ...result, evacuated: 0, sheltered: 2, frames: [frame] }}
      />,
    );
    const live = renderToStaticMarkup(
      <SimulationView building={tornado} result={null} live={{ frame }} />,
    );
    for (const screen of [html, live]) {
      expect(screen).not.toContain("Window service");
      expect(screen).not.toContain("Tornado response uses shelter zones");
      expect(screen).toContain("Sheltered");
      expect(screen).not.toContain('open=""');
    }
    expect(outsideDetails(html)).toContain("Sheltered (final)</dt><dd>2");
    expect(outsideDetails(live)).toContain("Sheltered</dt><dd>2");
  });

  it("keeps missing window data in Details only, and shows no Details before data arrives", () => {
    const legacy = renderToStaticMarkup(
      <SimulationView building={withWindow} result={result} />,
    );
    expect(legacy).toContain("Window service state is unavailable");
    expect(outsideDetails(legacy)).not.toContain(
      "Window service state is unavailable",
    );
    const awaiting = renderToStaticMarkup(
      <SimulationView building={withWindow} result={null} />,
    );
    const starting = renderToStaticMarkup(
      <SimulationView
        building={withWindow}
        result={null}
        live={{ frame: null }}
      />,
    );
    for (const html of [awaiting, starting]) {
      expect(html).not.toContain('<details class="simulation-details">');
      expect(html).not.toContain("Window service");
    }
  });
});
