// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import AnalyticsDashboard from "./AnalyticsDashboard";

afterEach(() => vi.unstubAllGlobals());
it("defaults to a concise Overview and preserves the detailed Advanced view", async () => {
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
    element.querySelector('[aria-label="Accumulated traffic heatmap"]'),
  ).toBeNull();
  const buttons = () => [...element.querySelectorAll("button")];
  await act(async () =>
    buttons()
      .find((b) => b.textContent === "Run stress test")!
      .click(),
  );
  expect(onStress).toHaveBeenCalledOnce();
  await act(async () =>
    buttons()
      .find((b) => b.textContent === "Advanced")!
      .click(),
  );
  expect(
    element
      .querySelector('[aria-label="Outcome overview"]')!
      .closest("[hidden]"),
  ).not.toBeNull();
  expect(
    element
      .querySelector('[aria-label="Accumulated traffic heatmap"]')!
      .closest("[hidden]"),
  ).toBeNull();
  await act(async () => root.unmount());
  element.remove();
});
