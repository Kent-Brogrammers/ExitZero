// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import example from "./editor/presets/corporate-office.json";
import App from "./App";
import { api } from "./services/api";
import type { BuildingScenario, SimulationResult } from "./types/simulation";

vi.mock("./services/api", () => ({
  api: {
    health: vi.fn(),
    optimize: vi.fn(),
    stressTest: vi.fn(),
    simulateLive: vi.fn(),
  },
}));
vi.mock("./simulation/SimulationView", () => ({
  SimulationView: ({ building, result, live }: Record<string, unknown>) => (
    <output data-testid="workspace-data">
      {JSON.stringify({ building, result, live })}
    </output>
  ),
}));

const recording: SimulationResult = {
  width: example.width,
  height: example.height,
  time_step_seconds: example.time_step_seconds,
  total_population: example.spawn_zones.reduce((n, zone) => n + zone.count, 0),
  evacuated: example.spawn_zones.reduce((n, zone) => n + zone.count, 0),
  remaining: 0,
  trapped: 0,
  status: "completed",
  clearance_steps: 1,
  frames: [
    { step: 0, agents: [] },
    { step: 1, agents: [] },
  ],
  traffic_samples: [],
};
let root: Root;
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.trim().startsWith(text),
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
function workspace() {
  return JSON.parse(
    document.querySelector('[data-testid="workspace-data"]')!.textContent!,
  ) as {
    building: BuildingScenario;
    result: SimulationResult | null;
    live: unknown;
  };
}
async function mount() {
  await act(async () => root.render(<App />));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  window.history.replaceState(null, "", "#building");
  document.body.innerHTML = '<div id="test-root"></div>';
  root = createRoot(document.getElementById("test-root")!);
  vi.mocked(api.health).mockResolvedValue({
    status: "ok",
    service: "exitzero",
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("optimization editor history", () => {
  it("undoes and redoes application separately from the preceding Fire edit", async () => {
    await mount();
    await click("Scenario");
    const fire = document.querySelector<HTMLInputElement>(
      '[aria-label="Fire evacuation"]',
    )!;
    await act(async () => {
      fire.click();
    });
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".scenario-apply")!.click(),
    );
    const beforeApplication = workspace().building;
    expect(beforeApplication.disaster?.kind).toBe("fire");
    const improved = structuredClone(beforeApplication);
    improved.doors[0]!.width += 0.5;
    vi.mocked(api.optimize).mockResolvedValue({
      baseline: { ...recording, clearance_steps: 100 },
      candidates: [
        {
          building: improved,
          rank: 1,
          metrics: { ...recording, clearance_steps: 90 },
        },
      ],
    });
    await click("Analytics");
    await click("Optimize");
    await act(async () => vi.dynamicImportSettled());
    await click("Apply candidate");
    expect(workspace().building).toEqual(improved);
    await click("Undo");
    expect(workspace().building).toEqual(beforeApplication);
    await click("Redo");
    expect(workspace().building).toEqual(improved);
    await click("Undo");
    await click("Undo");
    expect(workspace().building.disaster).toBeUndefined();
  });
});

describe("stopping live simulation", () => {
  it("aborts, discards old results and late frames, restores controls, and can run again", async () => {
    vi.mocked(api.simulateLive).mockResolvedValueOnce(recording);
    await mount();
    await click("Run Simulation");
    expect(workspace().result).toEqual(recording);
    vi.mocked(api.simulateLive).mockImplementationOnce(
      (_building, onFrame, signal) =>
        new Promise((_resolve, reject) => {
          onFrame(recording.frames[0]!);
          signal!.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          );
        }),
    );
    await click("Run Simulation");
    expect(workspace().result).toBeNull();
    const [, onFrame, signal] = vi.mocked(api.simulateLive).mock.calls[1]!;
    await click("Stop Simulation");
    expect(signal!.aborted).toBe(true);
    expect(workspace()).toMatchObject({ result: null, live: null });
    expect(button("Run Simulation").disabled).toBe(false);
    expect(document.body.textContent).toContain(
      "Simulation stopped. No recording was saved.",
    );
    expect(document.body.textContent).not.toContain(
      "The operation was aborted",
    );
    await act(async () => onFrame(recording.frames[0]!));
    expect(workspace().live).toBeNull();
    vi.mocked(api.simulateLive).mockResolvedValueOnce(recording);
    await click("Run Simulation");
    expect(workspace().result).toEqual(recording);
    expect(document.body.textContent).toContain("Recording ready.");
    expect(document.body.textContent).not.toContain("Stop Simulation");
  });

  it("does not accept a completion that arrives after Stop", async () => {
    let finish!: (result: SimulationResult) => void;
    vi.mocked(api.simulateLive).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    await click("Run Simulation");
    await click("Stop Simulation");
    await act(async () => finish(recording));
    expect(workspace()).toMatchObject({ result: null, live: null });
    expect(button("Run Simulation").disabled).toBe(false);
    expect(document.body.textContent).toContain("Simulation stopped.");
  });

  it("still reports a genuine simulation failure", async () => {
    vi.mocked(api.simulateLive).mockRejectedValueOnce(
      new Error("Placement failed"),
    );
    await mount();
    await click("Run Simulation");
    expect(document.body.textContent).toContain("Placement failed");
    expect(document.body.textContent).not.toContain("Simulation stopped.");
    expect(workspace()).toMatchObject({ result: null, live: null });
    expect(button("Run Simulation").disabled).toBe(false);
  });
});
