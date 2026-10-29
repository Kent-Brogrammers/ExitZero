// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import { BuildingEditor } from "./BuildingEditor";
import { canvasView } from "./geometry";

vi.mock("./draw", () => ({ drawLayout: vi.fn() }));

it("offers a single door tool, creates an exterior exit, and draws a polygon with keyboard completion", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const initial: BuildingScenario = {
    ...structuredClone(example),
    width: 20,
    height: 15,
    spawn_zones: [],
    doors: [],
    exits: [],
    blocked_exit_ids: [],
    obstructions: [],
    walls: [
      {
        id: "top",
        start: { x: 2, y: 2 },
        end: { x: 18, y: 2 },
        thickness: 0.2,
      },
      {
        id: "right",
        start: { x: 18, y: 2 },
        end: { x: 18, y: 13 },
        thickness: 0.2,
      },
      {
        id: "bottom",
        start: { x: 18, y: 13 },
        end: { x: 2, y: 13 },
        thickness: 0.2,
      },
      {
        id: "left",
        start: { x: 2, y: 13 },
        end: { x: 2, y: 2 },
        thickness: 0.2,
      },
    ],
  };
  let latest = initial;
  function Editor() {
    const [building, setBuilding] = useState(initial);
    return (
      <BuildingEditor
        building={building}
        onChange={(next) => {
          latest = next;
          setBuilding(next);
        }}
      />
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const click = async (label: string) => {
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
        .click(),
    );
  };
  try {
    await act(async () => root.render(<Editor />));
    expect(host.querySelector('button[aria-label="Exit"]')).toBeNull();
    const canvas = host.querySelector("canvas")!;
    canvas.width = 800;
    canvas.height = 600;
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    const view = canvasView(
      800,
      600,
      initial,
      { zoom: 1, pan: { x: 0, y: 0 }, extent: { width: 20, height: 15 } },
      window.devicePixelRatio,
    );
    async function point(x: number, y: number) {
      await act(async () =>
        canvas.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            pointerId: 1,
            clientX: view.x + x * view.scale,
            clientY: view.y + y * view.scale,
          }),
        ),
      );
    }
    await click("Door");
    await point(8, 2);
    expect(latest.exits).toHaveLength(1);
    expect(latest.doors).toHaveLength(0);
    await click("Spawn zone");
    await click("Draw Polygon");
    for (const p of [
      [4, 4],
      [10, 4],
      [10, 7],
      [4, 9],
    ])
      await point(p[0]!, p[1]!);
    await act(async () =>
      canvas.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(latest.spawn_zones).toHaveLength(1);
    expect(latest.spawn_zones[0]!.polygon).toHaveLength(4);
    expect(latest.spawn_zones[0]!.polygon![3]!.y).toBeCloseTo(9);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
