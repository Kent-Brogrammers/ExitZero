import { describe, expect, it } from "vitest";
import {
  outcomeExplanation,
  scenarioTitle,
  clearanceChange,
} from "./presentation";
import { syntheticStressResult } from "./stressFixture";

describe("result explanations", () => {
  it("uses recorded stopping reasons without inferring deaths or proven entrapment", () => {
    const incomplete = {
      ...syntheticStressResult.baseline,
      status: "incomplete" as const,
      clearance_steps: null,
    };
    expect(outcomeExplanation(incomplete, "no_active_routes")).toContain(
      "no remaining occupant had an active route",
    );
    expect(outcomeExplanation(incomplete, "no_active_routes")).toContain(
      "does not prove",
    );
    expect(outcomeExplanation(incomplete, "movement_stagnation")).toContain(
      "without movement or new information",
    );
    expect(clearanceChange(126, 210, 0.1)).toBe("+84 steps / 8.40 s (+66.7%)");
    expect(clearanceChange(126, 120)).toBe("-6 steps (-4.8%)");
    expect(clearanceChange(null, 120)).toContain("unavailable");
    expect(clearanceChange(0, 10)).not.toContain("%");
  });
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
