// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SimulationView } from "./SimulationView";
import { canvasView } from "../editor/geometry";
import {
  syntheticBuilding as building,
  syntheticResult,
} from "./playback.fixture";
import type { SimulationResult } from "../types/simulation";

vi.mock("../editor/draw", () => ({ drawLayout: vi.fn() }));
vi.mock("./drawPlayback", () => ({
  createPlaybackRenderer: vi.fn(() => vi.fn()),
  drawAgents: vi.fn(),
}));

// Scripted presentation fixture, not simulation output.
const result: SimulationResult = {
  ...syntheticResult,
  agent_events: [
    { step: 0, agent_id: 0, kind: "heading_to_exit", subject_id: "west" },
    { step: 25, agent_id: 0, kind: "rerouting", subject_id: "east" },
    { step: 80, agent_id: 0, kind: "evacuated", subject_id: "east" },
  ],
  analytics: {
    simulated_seconds: 8,
    median_evacuation_seconds: 8,
    total_distance_metres: 4,
    total_waiting_seconds: 0.5,
    agents: [
      {
        id: 0,
        distance_metres: 4,
        waiting_steps: 5,
        waiting_seconds: 0.5,
        elapsed_seconds: 8,
        evacuation_step: 80,
        evacuation_seconds: 8,
        exit_id: "east",
        route_found: true,
        exposure_seconds: 0.2,
      },
    ],
  },
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
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
const inspector = () => host.querySelector<HTMLElement>(".agent-inspector");
const button = (text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
async function choose(id: number) {
  const select = host.querySelector<HTMLSelectElement>(
    '[aria-label="Inspect agent"]',
  )!;
  await act(async () => {
    select.value = String(id);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function clickFirstAgent() {
  const canvas = host.querySelector("canvas")!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    left: 20,
    top: 30,
    width: 600,
    height: 400,
  } as DOMRect);
  const view = canvasView(canvas.width, canvas.height, building);
  await act(async () =>
    canvas.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: 20 + (view.x + 1.25 * view.scale) / 2,
        clientY: 30 + (view.y + 1.5 * view.scale) / 2,
      }),
    ),
  );
}

it("inspects departed occupants, separates final totals from the playhead, and rewinds activity", async () => {
  await act(async () =>
    root.render(<SimulationView building={building} result={result} />),
  );
  await choose(0);
  expect(inspector()!.textContent).toContain("Evacuated");
  expect(inspector()!.textContent).toContain("Full-run statistics");
  expect(inspector()!.textContent).toContain("0.50 s");
  expect(inspector()!.textContent).toContain("0.20 s");
  expect(inspector()!.textContent).toContain("I made it out");
  await act(async () => button("Reset").click());
  expect(inspector()!.textContent).toContain("In simulation");
  expect(inspector()!.textContent).toContain(
    "including movement after the playhead",
  );
  expect(inspector()!.textContent).not.toContain("Change of plan");
  expect(inspector()!.textContent).not.toContain("I made it out");
  expect(
    inspector()!.querySelector(".agent-inspector-events")!.textContent,
  ).toContain("Exit 1");
  await act(async () =>
    inspector()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(inspector()).toBeNull();
  expect(document.activeElement).toBe(host.querySelector("canvas"));
  await clickFirstAgent();
  expect(inspector()!.getAttribute("aria-label")).toBe("Agent 1 inspector");
  await act(async () =>
    root.render(<SimulationView building={building} result={{ ...result }} />),
  );
  expect(inspector()).toBeNull();
});

it("supports canvas selection and honest missing statistics in older recordings", async () => {
  await act(async () =>
    root.render(
      <SimulationView building={building} result={syntheticResult} />,
    ),
  );
  await act(async () => button("Reset").click());
  await clickFirstAgent();
  expect(inspector()!.textContent).toContain(
    "Per-agent statistics were not recorded",
  );
  const canvas = host.querySelector("canvas")!;
  await act(async () =>
    canvas.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 30 }),
    ),
  );
  expect(inspector()).toBeNull();
  await choose(0);
  expect(inspector()).not.toBeNull();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Close agent inspector"]')!
      .click(),
  );
  expect(inspector()).toBeNull();
});

it("inspects live samples without inventing final outcomes and resets selection for a restarted run", async () => {
  await act(async () =>
    root.render(
      <SimulationView
        building={building}
        result={null}
        live={{ frame: result.frames[0]! }}
      />,
    ),
  );
  await clickFirstAgent();
  expect(inspector()!.textContent).toContain("Latest received sample");
  expect(inspector()!.textContent).toContain(
    "Final statistics are available after the run finishes",
  );
  await act(async () =>
    root.render(
      <SimulationView
        building={building}
        result={null}
        live={{ frame: result.frames[1]! }}
      />,
    ),
  );
  expect(inspector()!.textContent).toContain("1.00 s");
  await act(async () =>
    root.render(
      <SimulationView
        building={building}
        result={null}
        live={{ frame: result.frames.at(-1)!, status: "cancelled" }}
      />,
    ),
  );
  expect(inspector()!.textContent).toContain("Not present in this frame");
  await act(async () =>
    root.render(
      <SimulationView
        building={building}
        result={null}
        live={{ frame: result.frames[0]! }}
      />,
    ),
  );
  expect(inspector()).toBeNull();
});

it.each([
  [undefined, "Healthy"],
  [0.2, "Injured"],
  [0.5, "Severely Injured"],
] as const)(
  "shows readable health for injury %s and the recorded desired-path legend",
  async (injury, expected) => {
    await act(async () =>
      root.render(
        <SimulationView
          building={building}
          result={null}
          live={{
            frame: {
              step: 0,
              agents: [
                {
                  id: 0,
                  x: 1.25,
                  y: 1.5,
                  injury,
                  planned_path: {
                    waypoints: [{ x: 0.5, y: 1.5 }],
                    continues: false,
                  },
                },
              ],
            },
          }}
        />,
      ),
    );
    await choose(0);
    const label = [...inspector()!.querySelectorAll("dt")].find(
      (field) => field.textContent === "Injury level",
    )!;
    expect(label.nextElementSibling!.textContent).toBe(expected);
    expect(inspector()!.textContent).toContain("Walked path");
    expect(inspector()!.textContent).toContain("Desired path");
    expect(inspector()!.textContent).toContain(
      "current route from the Rust engine",
    );
  },
);
