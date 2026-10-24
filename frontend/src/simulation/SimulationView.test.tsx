import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SimulationView } from "./SimulationView";
import {
  syntheticBuilding as building,
  syntheticResult as result,
} from "./playback.fixture";

describe("live first run and recorded review", () => {
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
});
