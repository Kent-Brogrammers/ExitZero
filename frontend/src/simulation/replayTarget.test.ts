import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { syntheticBuilding, syntheticResult } from "./playback.fixture";
import { snapshotFrameIndex } from "./replayTarget";
import CrowdingRanking from "../analytics/CrowdingRanking";
describe("snapshot replay navigation", () => {
  it("resolves exact recorded steps rather than treating steps as array indices", () => {
    const result = {
      ...syntheticResult,
      frames: [
        { step: 0, agents: [] },
        { step: 10, agents: [] },
        { step: 40, agents: [] },
      ],
    };
    expect(snapshotFrameIndex(result, 10)).toBe(1);
    expect(snapshotFrameIndex(result, 0)).toBe(0);
    expect(snapshotFrameIndex(result, 20)).toBe(-1);
  });
  it("provides accessible replay actions for computed snapshot cards", () => {
    const html = renderToStaticMarkup(
      createElement(CrowdingRanking, {
        building: syntheticBuilding,
        result: {
          ...syntheticResult,
          frames: [
            { step: 0, agents: [{ id: 0, x: 0.5, y: 1 }] },
            { step: 30, agents: [{ id: 0, x: 3, y: 1 }] },
          ],
        },
        onViewInSimulation: () => {},
      }),
    );
    expect(html).toContain("View in simulation");
    expect(html).toContain("View crowded spot 1 in simulation at 3.00 seconds");
  });
});
