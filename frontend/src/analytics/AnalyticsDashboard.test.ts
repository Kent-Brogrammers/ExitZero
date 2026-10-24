import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AnalyticsDashboard from "./AnalyticsDashboard";
import { syntheticStressResult } from "./stressFixture";
import type { SimulationResult } from "../types/simulation";

describe("computed analytics data flow", () => {
  it("waits for computed data and provides no synthetic preview controls", () => {
    const html = renderToStaticMarkup(
      createElement(AnalyticsDashboard, { result: null, stressResult: null }),
    );
    expect(html).toContain("No computed metrics");
    expect(html).not.toContain("synthetic preview");
    expect(html).not.toContain("Illustrative results");
    expect(html).not.toContain("sample-exit");
  });
  it("displays stress-test baseline metrics when no separate simulation exists", () => {
    const html = renderToStaticMarkup(
      createElement(AnalyticsDashboard, {
        result: null,
        stressResult: syntheticStressResult,
      }),
    );
    expect(html).toContain("Computed stress-test baseline");
    expect(html).toContain("34 / 34");
    expect(html).toContain("Exit sample-exit-a blocked");
  });
  it("uses the supplied simulation rather than invented counts", () => {
    const result: SimulationResult = {
      status: "completed",
      total_population: 7,
      evacuated: 7,
      remaining: 0,
      trapped: 0,
      clearance_steps: 42,
      frames: [],
      traffic_samples: [],
      time_step_seconds: 0.1,
      width: 30,
      height: 20,
    };
    const html = renderToStaticMarkup(
      createElement(AnalyticsDashboard, { result, stressResult: null }),
    );
    expect(html).toContain("Computed simulation");
    expect(html).toContain("7 / 7");
    expect(html).toContain("42 steps");
    expect(html).not.toContain("Synthetic UI fixture");
  });
});
