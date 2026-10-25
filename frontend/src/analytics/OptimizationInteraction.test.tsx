// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import { OptimizationComparison } from "./OptimizationComparison";
import { LayoutCanvas } from "./LayoutCanvas";
import { drawLayout } from "../editor/draw";
import type {
  OptimizationCandidate,
  SimulationMetrics,
} from "../types/simulation";

vi.mock("../editor/draw", () => ({ drawLayout: vi.fn() }));
const baseline: SimulationMetrics = {
  status: "completed",
  total_population: 34,
  evacuated: 34,
  remaining: 0,
  trapped: 0,
  clearance_steps: 123,
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.mocked(drawLayout).mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("selects actual candidate geometry by click and keyboard, highlights its opening, and only applies on request", async () => {
  const first = structuredClone(example),
    second = structuredClone(example);
  first.doors[0]!.width = 2.4;
  first.doors[0]!.offset = 2.5;
  second.exits[1]!.width += 0.5;
  const a: OptimizationCandidate = {
    rank: 1,
    building: first,
    metrics: { ...baseline, clearance_steps: 100 },
  };
  const b: OptimizationCandidate = {
    rank: 2,
    building: second,
    metrics: { ...baseline, clearance_steps: 110 },
  };
  const evaluation = {
    source: example,
    result: { baseline, candidates: [b, a] },
    applied: null,
  };
  const untouched = structuredClone(evaluation);
  const apply = vi.fn();
  await act(async () =>
    root.render(
      <OptimizationComparison
        evaluation={evaluation}
        onApply={apply}
        rerun={null}
      />,
    ),
  );
  const options = () => [
    ...host.querySelectorAll<HTMLButtonElement>('[role="option"]'),
  ];
  expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
  expect(vi.mocked(drawLayout).mock.lastCall?.[1]).toBe(first);
  expect(vi.mocked(drawLayout).mock.lastCall?.[2]).toEqual([
    { kind: "doors", id: first.doors[0]!.id },
  ]);
  expect(host.textContent).toContain("23 steps · 2.30 s · 18.7% faster");
  expect(host.textContent).not.toContain("Preview candidate 1");
  await act(async () => options()[1]!.click());
  expect(vi.mocked(drawLayout).mock.lastCall?.[1]).toBe(second);
  expect(vi.mocked(drawLayout).mock.lastCall?.[2]).toEqual([
    { kind: "exits", id: second.exits[1]!.id },
  ]);
  expect(host.querySelector("canvas")!.getAttribute("aria-label")).toContain(
    second.exits[1]!.id,
  );
  expect(apply).not.toHaveBeenCalled();
  await act(async () =>
    options()[1]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    ),
  );
  expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
  await act(async () =>
    options()[0]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(options()[1]);
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".optimization-apply")!.click(),
  );
  expect(apply).toHaveBeenCalledExactlyOnceWith(b);
  expect(evaluation).toEqual(untouched);
  const replacement = {
    source: example,
    result: { baseline, candidates: [a] },
    applied: null,
  };
  await act(async () =>
    root.render(
      <OptimizationComparison
        evaluation={replacement}
        onApply={apply}
        rerun={null}
        disabled
      />,
    ),
  );
  expect(vi.mocked(drawLayout).mock.lastCall?.[1]).toBe(first);
  expect(
    host.querySelector<HTMLButtonElement>(".optimization-apply")!.disabled,
  ).toBe(true);
});

it("draws the original and widened opening at their actual world coordinates", async () => {
  const context = {
    setTransform: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    setLineDash: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  };
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 900, 600));
  const candidate = structuredClone(example);
  candidate.doors[0]!.width = 2.4;
  candidate.doors[0]!.offset = 2.5;
  await act(async () =>
    root.render(
      <LayoutCanvas
        building={candidate}
        comparisonBuilding={example}
        label="Widened north door"
      />,
    ),
  );
  // The north door lies on the vertical partition starting at (15, 2).
  expect(context.moveTo.mock.calls).toEqual([
    [15, 4.5],
    [15, 5],
  ]);
  expect(context.lineTo.mock.calls).toEqual([
    [15, 6.9],
    [15, 6.4],
  ]);
  expect(context.setLineDash.mock.calls[0]).toEqual([[]]);
  expect(context.setLineDash.mock.calls[1]![0]).toHaveLength(2);
  expect(example.doors[0]!.width).toBe(1.4);
});
