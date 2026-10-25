// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SimulationView } from "./SimulationView";
import { drawLayout } from "../editor/draw";
import { syntheticBuilding, syntheticResult } from "./playback.fixture";
import type { DisasterState } from "../types/simulation";

vi.mock("../editor/draw", () => ({ drawLayout: vi.fn() }));
vi.mock("./drawPlayback", () => ({
  createPlaybackRenderer: vi.fn(() => vi.fn()),
  drawAgents: vi.fn(),
}));

it("draws recorded fire growth at the end, on rewind, and when stepping forward", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const first: DisasterState = {
    kind: "fire",
    areas: [{ id: 0, center: { x: 1, y: 1 }, radius: 0.2, revision: 0 }],
  };
  const last: DisasterState = {
    kind: "fire",
    areas: [
      { id: 0, center: { x: 1, y: 1 }, radius: 0.8, revision: 2 },
      { id: 1, center: { x: 2, y: 1 }, radius: 0.4, revision: 2 },
    ],
  };
  const building = {
    ...syntheticBuilding,
    disaster: { kind: "fire" as const, center: { x: 1, y: 1 }, radius: 0.2 },
  };
  const result = {
    ...syntheticResult,
    frames: [
      { ...syntheticResult.frames[0]!, step: 0, disaster_state: first },
      { ...syntheticResult.frames[1]!, step: 2, disaster_state: last },
    ],
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const drawnHazard = () =>
    vi.mocked(drawLayout).mock.lastCall?.[6]?.disasterState;
  try {
    await act(async () =>
      root.render(<SimulationView building={building} result={result} />),
    );
    expect(drawnHazard()).toEqual(last);
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Reset")!
        .click();
    });
    expect(drawnHazard()).toEqual(first);
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('[aria-label="Next recorded frame"]')!
        .click();
    });
    expect(drawnHazard()).toEqual(last);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
