import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type {
  OptimizationCandidate,
  SimulationMetrics,
  BuildingScenario,
} from "../types/simulation";
import {
  applyOptimizationCandidate,
  clearanceLabel,
  compareMetrics,
  openingChanges,
  type OptimizationEvaluation,
  improvementLabel,
} from "./optimization";
import { OptimizationComparison } from "./OptimizationComparison";

const baseline: SimulationMetrics = {
  status: "completed",
  total_population: 34,
  evacuated: 34,
  remaining: 0,
  trapped: 0,
  clearance_steps: 123,
};
function candidate(steps = 120, rank = 1): OptimizationCandidate {
  const building = structuredClone(example);
  building.exits[0]!.width = 2.1;
  return { building, rank, metrics: { ...baseline, clearance_steps: steps } };
}
describe("real-result optimization presentation and application", () => {
  it("formats actual clearance improvements without inventing null or zero-baseline percentages", () => {
    expect(
      improvementLabel(baseline, { ...baseline, clearance_steps: 120 }, 0.1),
    ).toBe("3 steps · 0.30 s · 2.4% faster");
    expect(
      improvementLabel({ ...baseline, clearance_steps: null }, baseline, 0.1),
    ).toBe("Full clearance comparison unavailable");
    expect(
      improvementLabel(
        { ...baseline, clearance_steps: 0 },
        { ...baseline, clearance_steps: 0 },
        0.1,
      ),
    ).not.toContain("%");
  });
  it("ranks the supplied improvements and compares their measured metrics", () => {
    const first = candidate(120, 1),
      second = candidate(121, 2);
    const evaluation: OptimizationEvaluation = {
      source: example,
      result: { baseline, candidates: [second, first] },
      applied: null,
    };
    const before = structuredClone(evaluation);
    const html = renderToStaticMarkup(
      <OptimizationComparison
        evaluation={evaluation}
        onApply={() => {}}
        rerun={null}
      />,
    );
    expect(html.indexOf("120 steps")).toBeLessThan(html.indexOf("121 steps"));
    expect(html).toContain("123 steps");
    expect(html).toContain("5.2 ft → 6.9 ft");
    expect(html).toContain("Candidate layout preview, rank 1");
    expect(html).toContain("Apply candidate");
    expect(evaluation).toEqual(before);
  });
  it("applies a validated independent clone and preserves current object names", () => {
    const current: BuildingScenario = structuredClone(example);
    current.exits[0]!.name = "Main exit";
    const improved = candidate();
    const beforeCurrent = structuredClone(current),
      beforeCandidate = structuredClone(improved);
    const next = applyOptimizationCandidate(current, baseline, improved);
    expect(next.exits[0]!.width).toBe(2.1);
    expect(next.exits[0]!.name).toBe("Main exit");
    expect(openingChanges(current, next)).toEqual([
      "Exit Main exit: 5.2 ft → 6.9 ft",
    ]);
    next.walls[0]!.start.x = 0.25;
    expect(current).toEqual(beforeCurrent);
    expect(improved).toEqual(beforeCandidate);
  });
  it("rejects equal/worse metrics and invalid geometry without mutating the building", () => {
    expect(() =>
      applyOptimizationCandidate(example, baseline, candidate(123)),
    ).toThrow("strict improvement");
    expect(() =>
      applyOptimizationCandidate(example, baseline, candidate(130)),
    ).toThrow("strict improvement");
    const invalid = candidate();
    invalid.building.exits[0]!.width = 100;
    expect(() =>
      applyOptimizationCandidate(example, baseline, invalid),
    ).toThrow("Cannot apply");
  });
  it("handles incomplete baselines, null clearance, and zero-step clearance", () => {
    const incomplete: SimulationMetrics = {
      ...baseline,
      status: "incomplete",
      evacuated: 24,
      remaining: 10,
      clearance_steps: null,
    };
    expect(
      compareMetrics(
        { ...incomplete, remaining: 9, evacuated: 25 },
        incomplete,
      ),
    ).toBe(-1);
    expect(compareMetrics(baseline, incomplete)).toBe(-1);
    expect(compareMetrics({ ...baseline, clearance_steps: 0 }, baseline)).toBe(
      -1,
    );
    expect(compareMetrics(incomplete, { ...incomplete })).toBe(0);
    expect(clearanceLabel(0)).toBe("0 steps");
    expect(clearanceLabel(null)).toBe("No measured clearance");
    const html = renderToStaticMarkup(
      <OptimizationComparison
        evaluation={{
          source: example,
          result: { baseline: incomplete, candidates: [candidate(0)] },
          applied: null,
        }}
        onApply={() => {}}
        rerun={null}
      />,
    );
    expect(html).toContain("No measured clearance");
    expect(html).toContain("0 steps");
  });
  it("shows an empty successful search without inventing recommendations", () => {
    const html = renderToStaticMarkup(
      <OptimizationComparison
        evaluation={{
          source: example,
          result: { baseline, candidates: [] },
          applied: null,
        }}
        onApply={() => {}}
        rerun={null}
      />,
    );
    expect(html).toContain("No strict improvement was found");
    expect(html).not.toContain("Apply candidate");
  });
  it("retains the original baseline alongside an actual applied-layout rerun", () => {
    const improved = candidate();
    const rerun = {
      ...improved.metrics,
      width: 30,
      height: 20,
      time_step_seconds: 0.1,
      frames: [],
      traffic_samples: [],
    };
    const html = renderToStaticMarkup(
      <OptimizationComparison
        evaluation={{
          source: example,
          result: { baseline, candidates: [improved] },
          applied: improved,
        }}
        onApply={() => {}}
        rerun={rerun}
      />,
    );
    expect(html).toContain("Candidate applied");
    expect(html).toContain("Applied layout rerun: 34 / 34 evacuated");
    expect(html).toContain("Original baseline: 123 steps");
  });
});
