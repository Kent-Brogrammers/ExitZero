import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SimulationResult } from "../types/simulation";
import { SimulationSummary } from "./SimulationSummary";

// Deliberately different from both checked-in preview fixtures.
const recording: SimulationResult = {
  status: "incomplete",
  total_population: 7,
  evacuated: 3,
  remaining: 4,
  trapped: 2,
  clearance_steps: null,
  time_step_seconds: 0.2,
  width: 30,
  height: 20,
  traffic_samples: [],
  frames: [{ step: 10, agents: [{ id: 11, x: 3, y: 4 }] }],
};
function summary(
  result: SimulationResult | null,
  time: number | null = 2,
  synthetic = false,
) {
  return renderToStaticMarkup(
    <SimulationSummary
      result={result}
      playheadTime={time}
      synthetic={synthetic}
      onClose={() => {}}
    />,
  );
}

describe("read-only playback summary", () => {
  it("uses the recording's outcome without inferring population totals from frame agents", () => {
    const html = summary(recording);
    expect(html).toContain("Final recorded outcome");
    expect(html).toContain("Total occupants</dt><dd>7");
    expect(html).toContain("Evacuated</dt><dd>3");
    expect(html).toContain("Remaining</dt><dd>4");
    expect(html).toContain("Trapped</dt><dd>2");
    expect(html).toContain(
      "Counts describe the final outcome, not the playhead.",
    );
    expect(html).toContain("API recording");
    expect(html).not.toContain("Synthetic playback fixture");
  });
  it("keeps final outcomes stable while seeking, and does not equate the last sample with run time", () => {
    const html = summary(recording, 5);
    expect(html).toContain("5.00 s");
    expect(html).toContain("Run simulation time</dt><dd>Unavailable");
    expect(html).toContain("Evacuated</dt><dd>3");
  });
  it("uses optional engine time, or measured clearance time, with the actual time step", () => {
    const completed = {
      ...recording,
      status: "completed" as const,
      evacuated: 7,
      remaining: 0,
      trapped: 0,
      clearance_steps: 35,
    };
    expect(summary(completed)).toContain("Run simulation time</dt><dd>7.00 s");
    expect(
      summary({
        ...recording,
        analytics: {
          agents: Array.from({ length: 7 }, (_, id) => ({
            id,
            distance_metres: 0,
            waiting_steps: 0,
            waiting_seconds: 0,
            elapsed_seconds: id < 3 ? 2 : 14,
            evacuation_step: id < 3 ? 10 : null,
            evacuation_seconds: id < 3 ? 2 : null,
            exit_id: id < 3 ? "west" : null,
            route_found: id < 5,
          })),
          simulated_seconds: 14,
          median_evacuation_seconds: 2,
          total_distance_metres: 0,
          total_waiting_seconds: 0,
        },
      }),
    ).toContain("Run simulation time</dt><dd>14.00 s");
  });
  it("shows no invented zeros or fixture metrics while awaiting results", () => {
    const html = summary(null, null);
    expect(html).toContain("Awaiting results");
    expect(html).toContain("No matching simulation result");
    expect(html).not.toContain("Total occupants");
    expect(html).not.toContain("Final recorded outcome");
  });
  it("can show an outcome without frames, and distinguishes timeout from completion", () => {
    const html = summary({ ...recording, status: "timeout", frames: [] }, null);
    expect(html).toContain("Playhead time</span><strong>Unavailable");
    expect(html).toContain("Step limit reached");
    expect(html).toContain("Total occupants</dt><dd>7");
  });
  it("labels synthetic values and keeps the full Analytics destination separate", () => {
    const html = summary(recording, 0, true);
    expect(html).toContain("Synthetic playback fixture");
    expect(html).toContain("No simulation was run");
    expect(html).toContain("not your edited building");
    expect(html).toContain(
      "Full Analytics shows API results, independently of this playback fixture.",
    );
    expect(html).toContain('href="#analytics"');
    expect(html).not.toContain("API recording");
  });
});
