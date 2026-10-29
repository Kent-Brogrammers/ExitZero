// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TrafficHeatmap from "./TrafficHeatmap";
import {
  syntheticBuilding as building,
  syntheticResult,
} from "../simulation/playback.fixture";
import type { SimulationResult } from "../types/simulation";

let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(result: SimulationResult) {
  await act(async () =>
    root.render(<TrafficHeatmap building={building} result={result} />),
  );
}

describe("computed congestion heatmap", () => {
  it("marks legacy visit-only recordings unavailable instead of displaying traffic as congestion", async () => {
    await render({
      ...syntheticResult,
      traffic_samples: [{ x: 1, y: 1, visits: 999 }],
    });
    expect(element.textContent).toContain("Congestion data is unavailable");
    expect(element.querySelector("canvas")).toBeNull();
    expect(element.textContent).not.toContain("999");
  });

  it("distinguishes a computed zero-delay run from unavailable data", async () => {
    await render({ ...syntheticResult, congestion_samples: [] });
    expect(element.textContent).toContain("No crowd delay was recorded.");
    expect(element.textContent).not.toContain("unavailable");
    expect(
      element.querySelector("canvas")?.getAttribute("aria-label"),
    ).toContain("Maximum 0.00 crowd-delay person-seconds");
  });

  it("shows fractional backend delay weights and the metric's population/time meaning", async () => {
    await render({
      ...syntheticResult,
      traffic_samples: [{ x: 1, y: 1, visits: 999 }],
      congestion_samples: [
        { x: 1, y: 1, crowd_delay_seconds: 0.25 },
        { x: 1, y: 1, crowd_delay_seconds: 0.5 },
      ],
    });
    expect(element.textContent).toContain(
      "Peak source bin: 0.75 person-seconds",
    );
    expect(element.textContent).toContain("longer waits");
    expect(element.textContent).toContain("freely moving traffic adds none");
    expect(
      element.querySelector("canvas")?.getAttribute("aria-label"),
    ).toContain("Maximum 0.75 crowd-delay person-seconds");
    expect(element.textContent).not.toContain("999");
  });
});
