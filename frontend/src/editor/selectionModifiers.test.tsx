// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import { BuildingEditor } from "./BuildingEditor";
import { canvasView } from "./geometry";

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

it.each([
  ["Ctrl", { ctrlKey: true }],
  ["Cmd", { metaKey: true }],
  ["Shift", { shiftKey: true }],
  ["macOS Control context-click", { ctrlKey: true, button: 2 }],
] as const)(
  "%s toggles items and extends a marquee without editing the model",
  async (_, modifiers) => {
    const building = {
      ...structuredClone(example),
      width: 20,
      height: 15,
      walls: [],
      doors: [],
      exits: [],
      windows: [],
      spawn_zones: [],
      blocked_exit_ids: [],
      obstructions: [
        { id: "a", x: 3, y: 3, width: 2, height: 2 },
        { id: "b", x: 9, y: 6, width: 2, height: 2 },
        { id: "c", x: 14, y: 10, width: 2, height: 2 },
      ],
    };
    const change = vi.fn(),
      original = JSON.stringify(building);
    await act(async () =>
      root.render(<BuildingEditor building={building} onChange={change} />),
    );
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
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    canvas.hasPointerCapture = vi.fn(() => false);
    const view = canvasView(800, 600, building);
    async function pointer(
      type: string,
      x: number,
      y: number,
      options: PointerEventInit = {},
    ) {
      await act(async () => {
        canvas.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 1,
            button: 0,
            clientX: view.x + x * view.scale,
            clientY: view.y + y * view.scale,
            ...options,
          }),
        );
      });
    }
    async function click(x: number, y: number, options: PointerEventInit = {}) {
      await pointer("pointerdown", x, y, options);
      await pointer("pointerup", x, y, options);
    }
    const count = () => canvas.getAttribute("data-selected-count");
    await click(4, 4);
    await click(10, 7, modifiers);
    expect(count()).toBe("2");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!
        .click(),
    );
    const arrange = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Arrange…",
    )!;
    expect(arrange.disabled).toBe(false);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!
        .click(),
    );
    await click(4, 4, modifiers);
    expect(count()).toBe("1");
    await click(4, 4);
    await pointer("pointerdown", 13.5, 9.5, modifiers);
    await pointer("pointermove", 16.5, 12.5, modifiers);
    await pointer("pointerup", 16.5, 12.5, modifiers);
    expect(count()).toBe("2");
    expect(change).not.toHaveBeenCalled();
    expect(JSON.stringify(building)).toBe(original);
  },
);
