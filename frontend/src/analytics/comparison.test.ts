import { expect, it } from "vitest";
import { comparisonContext } from "./comparison";
import {
  syntheticBuilding,
  syntheticResult,
} from "../simulation/playback.fixture";

it("compares layout changes only under matching starting conditions and discloses incompatible experiments", () => {
  const before = {
    building: syntheticBuilding,
    result: syntheticResult,
    source: "computed" as const,
  };
  const changed = structuredClone(syntheticBuilding);
  changed.exits[0]!.width += 0.5;
  const controlled = comparisonContext(before, changed, syntheticResult);
  expect(controlled.differences).toEqual([]);
  expect(controlled.changes.join()).toContain("→");
  changed.seed += 1;
  changed.disaster = { kind: "fire", center: { x: 1, y: 1 }, radius: 0.2 };
  changed.max_steps += 1;
  const context = comparisonContext(before, changed, {
    ...syntheticResult,
    frames: [],
  });
  expect(context.differences).toEqual(
    expect.arrayContaining([
      "random seed changed",
      "hazard or shelter configuration changed",
      "simulation settings changed",
      "starting-position fairness is unverified",
    ]),
  );
  expect(
    comparisonContext(
      { ...before, source: "recorded_demo" },
      syntheticBuilding,
      syntheticResult,
    ).differences.join(),
  ).toContain("engine-version equivalence is unverified");
});
