import Ajv from "ajv";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import contracts from "../../../shared/schemas/contracts.schema.json";
import ScenarioComparison from "./ScenarioComparison";
import { syntheticStressResult } from "./stressFixture";

describe("stress comparison", () => {
  it("uses schema-valid fixtures with consistent populations and clearance", () => {
    const ajv = new Ajv({ allErrors: true });
    ajv.addSchema(contracts);
    const validate = ajv.getSchema(`${contracts.$id}#/$defs/StressTestResult`)!;
    expect(
      validate(syntheticStressResult),
      ajv.errorsText(validate.errors),
    ).toBe(true);
    for (const metrics of [
      syntheticStressResult.baseline,
      ...syntheticStressResult.scenarios.map((s) => s.metrics),
    ]) {
      expect(metrics.evacuated + metrics.remaining).toBe(
        metrics.total_population,
      );
      expect(metrics.trapped).toBeLessThanOrEqual(metrics.remaining);
      expect(metrics.clearance_steps === null).toBe(
        metrics.status !== "completed",
      );
    }
  });
  it("shows backend rank order without mutating results and explains incomplete clearance", () => {
    const before = structuredClone(syntheticStressResult);
    const html = renderToStaticMarkup(
      createElement(ScenarioComparison, { result: syntheticStressResult }),
    );
    expect(html.indexOf("Exit sample-exit-a blocked")).toBeLessThan(
      html.indexOf("Obstruction: sample-barrier"),
    );
    expect(html.indexOf("Obstruction: sample-barrier")).toBeLessThan(
      html.indexOf("Exit sample-exit-b blocked"),
    );
    expect(html).toContain("No measured clearance");
    expect(html).toContain("12 more");
    expect(html).toContain("both runs need measured clearance");
    expect(syntheticStressResult).toEqual(before);
  });
  it("handles missing results and a baseline without stress scenarios", () => {
    expect(
      renderToStaticMarkup(createElement(ScenarioComparison, { result: null })),
    ).toContain("No scenarios evaluated");
    const html = renderToStaticMarkup(
      createElement(ScenarioComparison, {
        result: { baseline: syntheticStressResult.baseline, scenarios: [] },
      }),
    );
    expect(html).toContain("Baseline metrics are shown");
    expect(html).not.toContain("Selected scenario details");
  });
});
