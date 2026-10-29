// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import exampleJson from "./editor/presets/corporate-office.json";
import { halloweenPreset } from "./editor/presets";
import App from "./App";
import { api } from "./services/api";
import { storeLayout } from "./templates/layouts";
import { readTemplates, TEMPLATE_STORAGE_KEY } from "./templates/templates";
import type { BuildingScenario, SimulationResult } from "./types/simulation";

const example = exampleJson as BuildingScenario;

vi.mock("./services/api", () => ({
  api: {
    health: vi.fn(),
    optimize: vi.fn(),
    stressTest: vi.fn(),
    simulateLive: vi.fn(),
    cancelComputation: vi.fn(),
    listJobs: vi.fn(),
    simulate: vi.fn(),
    recordScenario: vi.fn(),
    jobRequest: vi.fn(),
    jobResult: vi.fn(),
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
  const found = [...document.querySelectorAll("button")].find(
    (element) =>
      !element.closest("[hidden]") &&
      (
        element.getAttribute("aria-label") ?? element.textContent?.trim()
      )?.startsWith(text),
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
  vi.mocked(api.cancelComputation).mockResolvedValue({ status: "cancelling" });
  vi.mocked(api.listJobs).mockResolvedValue({ server_id: "test", jobs: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("optimization editor history", () => {
  it("clears the visible blueprint in Edit and restores the whole layout with Undo", async () => {
    await mount();
    await click("Settings");
    await click("Hackathon Origins");
    await click("Edit house");
    const original = structuredClone(workspace().building);
    expect(original.walls.length).toBeGreaterThan(0);
    expect(original.pursuit).toBeDefined();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );

    await click("Clear Plan");
    const cleared = workspace().building;
    for (const field of [
      "walls",
      "doors",
      "exits",
      "windows",
      "spawn_zones",
      "placed_occupants",
      "obstructions",
      "stair_areas",
      "tornado_zones",
      "blocked_exit_ids",
      "opening_events",
    ] as const)
      expect(cleared[field]).toEqual([]);
    expect(cleared.pursuit).toBeUndefined();
    expect(cleared.disaster).toBeUndefined();
    expect(cleared.window_escape_context).toBeUndefined();
    expect([cleared.width, cleared.height]).toEqual([
      original.width,
      original.height,
    ]);
    expect(window.location.hash).toBe("#building");
    await click("Undo");
    expect(workspace().building).toEqual(original);
    await click("Redo");
    expect(workspace().building).toEqual(cleared);
  });

  it("keeps a saved layout intact when opening another layout's computation", async () => {
    window.localStorage.removeItem(TEMPLATE_STORAGE_KEY);
    const saved = storeLayout(
      window.localStorage,
      example,
      "Original saved layout",
      "layout",
    );
    const other = structuredClone(example);
    other.doors[0]!.width += 0.5;
    vi.mocked(api.jobRequest).mockResolvedValue({
      kind: "simulate",
      building: other,
    });
    vi.mocked(api.jobResult).mockResolvedValue(recording);
    vi.mocked(api.listJobs).mockResolvedValue({
      server_id: "test",
      jobs: [
        {
          id: "other-run",
          server_id: "test",
          kind: "simulate",
          status: "completed",
          cached: false,
          error: null,
          progress: {
            evaluations_completed: 1,
            evaluations_total: 1,
            step: 1,
            step_limit: 100,
          },
        },
      ],
    });
    try {
      await mount();
      await click("Templates");
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            '[aria-label="Original saved layout template"] .template-card-edit',
          )!
          .click(),
      );
      expect(
        document.querySelector('[aria-label="Layout save status"]')!
          .textContent,
      ).toContain(saved.name);
      await click("Computations");
      await click("Open results");
      expect(workspace().building).toEqual(other);
      await click("Edit");
      await click("Save");
      const dialog = document.querySelector<HTMLDialogElement>(
        ".layout-name-dialog",
      );
      expect(dialog?.open).toBe(true);
      expect(dialog!.textContent).toContain("Save layout");
      expect(readTemplates(window.localStorage)).toEqual([saved]);
      await click("Cancel");
    } finally {
      window.localStorage.removeItem(TEMPLATE_STORAGE_KEY);
    }
  });

  it("runs the Origins house directly rather than the previously open layout", async () => {
    vi.mocked(api.simulateLive).mockResolvedValue(recording);
    await mount();
    const previous = structuredClone(workspace().building);
    await click("Settings");
    await click("Hackathon Origins");
    await click("Play Halloween map");
    const sent = vi.mocked(api.simulateLive).mock.calls[0]![0];
    expect(sent.pursuit).toEqual(halloweenPreset.building.pursuit);
    expect(sent.walls).toEqual(halloweenPreset.building.walls);
    expect(sent.walls).not.toEqual(previous.walls);
    expect(halloweenPreset.building.walls).not.toBe(sent.walls);
    expect(document.querySelector(".settings-dialog")).toBeNull();
    expect(window.location.hash).toBe("#simulation");
  });

  it("allows editing the Origins house offline without offering an unavailable simulation", async () => {
    vi.mocked(api.health).mockRejectedValue(new Error("Offline"));
    await mount();
    await click("Settings");
    await click("Hackathon Origins");
    expect(button("Play Halloween map").disabled).toBe(true);
    expect(button("Edit house").disabled).toBe(false);
    await click("Edit house");
    expect(workspace().building.pursuit).toEqual(
      halloweenPreset.building.pursuit,
    );
    expect(api.simulateLive).not.toHaveBeenCalled();
  });

  it("keeps pursuit outside safety analysis even before a recording exists", async () => {
    await mount();
    await click("Settings");
    await click("Hackathon Origins");
    await click("Edit house");
    expect(workspace().building.pursuit).toBeDefined();
    await click("Analytics");
    await act(async () => vi.dynamicImportSettled());
    expect(button("Stress Test").disabled).toBe(true);
    expect(button("Optimize").disabled).toBe(true);
    expect(
      [...document.querySelectorAll("button")]
        .filter((b) => !b.closest("[hidden]"))
        .some((b) => b.textContent === "Run stress test"),
    ).toBe(false);
    expect(api.stressTest).not.toHaveBeenCalled();
    expect(api.optimize).not.toHaveBeenCalled();
  });
  it("preserves the original recording after applying a candidate and rerunning", async () => {
    vi.mocked(api.simulateLive).mockResolvedValue(recording);
    await mount();
    await click("Run Simulation");
    const original = structuredClone(workspace().building);
    const improved = structuredClone(original);
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
    const rerun = { ...recording, clearance_steps: 2 };
    vi.mocked(api.simulate).mockResolvedValue(rerun);
    await click("Calculate Results");
    expect(workspace().building).toEqual(improved);
    expect(document.body.textContent).toContain(
      "Actual original and modified outcomes",
    );
    await click("Watch original recording");
    expect(workspace().building).toEqual(original);
    expect(workspace().result).toEqual(recording);
    await click("Return to comparison / baseline");
    expect(workspace().building).toEqual(improved);
    expect(workspace().result).toEqual(rerun);
  });
  it("watches the selected stress recording without replacing the editable layout or baseline", async () => {
    vi.mocked(api.simulateLive).mockResolvedValue(recording);
    await mount();
    await click("Run Simulation");
    const original = structuredClone(workspace().building);
    const modified = { ...original, blocked_exit_ids: ["west"] };
    vi.mocked(api.stressTest).mockImplementation(
      async (_request, _signal, _id, onStatus) => {
        onStatus!({
          id: "stress-origin",
          server_id: "test",
          kind: "stress",
          status: "completed",
          cached: false,
          error: null,
          progress: {
            evaluations_completed: 2,
            evaluations_total: 2,
            step: 1,
            step_limit: 100,
          },
        });
        return {
          baseline: recording,
          scenarios: [
            {
              scenario_id: "block-exit:west",
              description: "West exit closed.",
              modifications: {
                blocked_exit_ids: ["west"],
                added_obstructions: [],
              },
              metrics: recording,
              rank: 1,
              severity: "low",
            },
          ],
        };
      },
    );
    vi.mocked(api.recordScenario).mockResolvedValue({
      stress_job_id: "stress-origin",
      scenario_id: "block-exit:west",
      building: modified,
      result: { ...recording, clearance_steps: 2 },
    });
    await click("Analytics");
    await click("Stress Test");
    await act(async () => vi.dynamicImportSettled());
    await click("Watch Scenario");
    expect(api.recordScenario).toHaveBeenCalledWith(
      "stress-origin",
      "block-exit:west",
      expect.any(AbortSignal),
      expect.any(String),
      expect.any(Function),
    );
    expect(workspace().building).toEqual(modified);
    expect(workspace().result?.clearance_steps).toBe(2);
    await click("Return to comparison / baseline");
    expect(workspace().building).toEqual(original);
    expect(workspace().result).toEqual(recording);
  });
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
    expect(workspace()).toMatchObject({
      result: null,
      live: { status: "cancelled" },
    });
    expect(button("Run Simulation").disabled).toBe(false);
    expect(document.body.textContent).toContain(
      "Simulation stopped. No recording was saved.",
    );
    expect(document.body.textContent).not.toContain(
      "The operation was aborted",
    );
    await act(async () => onFrame(recording.frames[0]!));
    expect(workspace().live).toMatchObject({
      status: "cancelled",
      frame: recording.frames[0],
    });
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
    expect(workspace()).toMatchObject({
      result: null,
      live: { status: "cancelled" },
    });
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

describe("stopping analysis computations", () => {
  it.each(["Stress Test", "Optimize"])(
    "cancels %s on the server, preserves the baseline, and rejects late results",
    async (action) => {
      vi.mocked(api.simulateLive).mockResolvedValue(recording);
      await mount();
      await click("Run Simulation");
      await click("Analytics");
      let finish!: () => void;
      if (action === "Stress Test") {
        vi.mocked(api.stressTest).mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = () => resolve({ baseline: recording, scenarios: [] });
            }),
        );
      } else {
        vi.mocked(api.optimize).mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = () => resolve({ baseline: recording, candidates: [] });
            }),
        );
      }
      await click(action);
      const mock =
        action === "Stress Test"
          ? vi.mocked(api.stressTest)
          : vi.mocked(api.optimize);
      const [, signal, id] = mock.mock.calls[0]!;
      expect(id).toBeTruthy();
      await click(
        action === "Optimize" ? "Stop Optimization" : "Stop Stress Test",
      );
      expect(api.cancelComputation).toHaveBeenCalledWith(id);
      expect(signal!.aborted).toBe(false);
      await act(async () => finish());
      expect(signal!.aborted).toBe(true);
      expect(workspace().result).toEqual(recording);
      expect(button("Run Simulation").disabled).toBe(false);
      expect(document.body.textContent).toContain(
        "Previous results were preserved.",
      );
      expect(document.body.textContent).not.toContain("Stress test ready.");
      expect(document.body.textContent).not.toContain(
        "layout improvements found.",
      );
    },
  );

  it("keeps work connected when Stop fails and leaves background work reconnectable on page departure", async () => {
    vi.mocked(api.stressTest).mockImplementation(
      (_payload, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    await mount();
    await click("Analytics");
    await click("Stress Test");
    const [, signal, id] = vi.mocked(api.stressTest).mock.calls[0]!;
    vi.mocked(api.cancelComputation).mockRejectedValueOnce(
      new Error("Network unavailable"),
    );
    await click("Stop Stress Test");
    expect(signal!.aborted).toBe(false);
    expect(document.body.textContent).toContain(
      "Could not confirm cancellation",
    );
    expect(button("Stop Stress Test").disabled).toBe(false);
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(api.cancelComputation).toHaveBeenLastCalledWith(id);
    expect(api.cancelComputation).toHaveBeenCalledTimes(1);
    expect(signal!.aborted).toBe(true);
  });
});
