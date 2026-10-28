// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import AnalyticsDashboard from "./AnalyticsDashboard";
import {
  syntheticBuilding,
  syntheticResult,
} from "../simulation/playback.fixture";

afterEach(() => vi.unstubAllGlobals());
it("shows summaries and detailed analytics together without view tabs", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const onStress = vi.fn();
  await act(async () =>
    root.render(
      <AnalyticsDashboard
        result={null}
        stressResult={null}
        onStress={onStress}
      />,
    ),
  );
  expect(
    element
      .querySelector('[aria-label="Outcome overview"]')!
      .closest("[hidden]"),
  ).toBeNull();
  expect(
    element
      .querySelector('[aria-label="Accumulated traffic heatmap"]')!
      .closest("[hidden]"),
  ).toBeNull();
  const buttons = () => [...element.querySelectorAll("button")];
  await act(async () =>
    buttons()
      .find((b) => b.textContent === "Run stress test")!
      .click(),
  );
  expect(onStress).toHaveBeenCalledOnce();
  expect(
    buttons().some((b) =>
      ["Overview", "Advanced"].includes(b.textContent ?? ""),
    ),
  ).toBe(false);
  expect(element.querySelector('[aria-label="Analytics view"]')).toBeNull();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  await act(async () =>
    root.render(
      <AnalyticsDashboard
        result={syntheticResult}
        stressResult={null}
        building={syntheticBuilding}
        baseline={{
          building: syntheticBuilding,
          result: syntheticResult,
          source: "computed",
        }}
      />,
    ),
  );
  expect(
    element
      .querySelector('[aria-label="Population breakdown"]')!
      .closest("details"),
  ).toBeNull();
  expect(
    element
      .querySelector('[aria-label="Peak crowding rankings"]')!
      .closest("details"),
  ).toBeNull();
  expect(
    [...element.querySelectorAll("details")].filter(
      (details) => !details.closest("[hidden]"),
    ),
  ).toHaveLength(0);
  await act(async () => root.unmount());
  element.remove();
});
