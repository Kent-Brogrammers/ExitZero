import { describe, expect, it } from "vitest";
import { outcomeExplanation, scenarioTitle } from "./presentation";
import { syntheticStressResult } from "./stressFixture";

describe("result explanations", () => {
  it("uses blocker metadata for short labels and preserves the full description separately", () => {
    const scenario = syntheticStressResult.scenarios[1]!;
    expect(
      scenarioTitle({
        ...scenario,
        description: "A very long backend explanation. With fairness notes.",
      }),
    ).toBe("Exit sample-exit-a blocked");
  });
  it("does not claim incomplete runs have a known termination reason or that zero trapped means safe", () => {
    expect(
      outcomeExplanation({
        ...syntheticStressResult.baseline,
        status: "incomplete",
        remaining: 14,
        evacuated: 20,
        clearance_steps: null,
      }),
    ).toContain("does not report which stopping condition");
    expect(
      outcomeExplanation({
        ...syntheticStressResult.baseline,
        status: "timeout",
        remaining: 1,
        evacuated: 33,
        clearance_steps: null,
      }),
    ).toContain("step limit");
    expect(outcomeExplanation(syntheticStressResult.baseline)).toContain(
      "All occupants evacuated",
    );
  });
});
