// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario, DisasterKind } from "../types/simulation";
import { BuildingEditor } from "./BuildingEditor";
import { canvasView } from "./geometry";
import { defaultDynamics } from "./disasterDynamics";

vi.mock("./draw", () => ({ drawLayout: vi.fn() }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it.each(["fire", "gas_leak", "tornado"] as DisasterKind[])(
  "opens %s parameters by double-clicking its footprint and applies or discards edits",
  async (kind) => {
    const initial: BuildingScenario = {
      ...structuredClone(example),
      disaster: {
        kind,
        center: { x: 5, y: 5 },
        radius: 1,
        dynamics: defaultDynamics(kind, 1),
      },
    };
    const change = vi.fn();
    function Editor() {
      const [building, setBuilding] = useState(initial);
      return (
        <BuildingEditor
          building={building}
          onChange={(next) => {
            change(next);
            setBuilding(next);
          }}
        />
      );
    }
    await act(async () => root.render(<Editor />));
    const canvas = host.querySelector<HTMLCanvasElement>(
      "canvas[data-world-canvas]",
    )!;
    canvas.width = 800;
    canvas.height = 600;
    canvas.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    });
    const view = canvasView(800, 600, initial);
    async function doubleClick(x: number, y: number) {
      await act(async () =>
        canvas.dispatchEvent(
          new MouseEvent("dblclick", {
            bubbles: true,
            clientX: view.x + x * view.scale,
            clientY: view.y + y * view.scale,
          }),
        ),
      );
    }
    async function button(label: string) {
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((b) => b.textContent?.trim() === label)!
          .click(),
      );
    }
    // Outside the hazard must not open its controls.
    await doubleClick(8, 5);
    expect(host.querySelector(".scenario-dialog")).toBeNull();
    // The footprint, including away from its draggable centre, is editable.
    await doubleClick(5.8, 5);
    expect(
      host.querySelector<HTMLDialogElement>(".scenario-dialog")?.open,
    ).toBe(true);
    const radius = host.querySelector<HTMLInputElement>(
      '[aria-label="Hazard radius"]',
    )!;
    expect(radius).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(radius, "6.5616"); // Two metres in the default feet display.
      radius.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await button("Cancel");
    expect(change).not.toHaveBeenCalled();
    await doubleClick(5, 5);
    const reopened = host.querySelector<HTMLInputElement>(
      '[aria-label="Hazard radius"]',
    )!;
    expect(Number(reopened.value)).toBeCloseTo(3.2808);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(reopened, "6.5616");
      reopened.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await button("Apply");
    expect(change).toHaveBeenCalledOnce();
    expect(change.mock.calls[0]![0].disaster.radius).toBeCloseTo(2, 3);
    expect(host.querySelector(".scenario-dialog")).toBeNull();
  },
);
