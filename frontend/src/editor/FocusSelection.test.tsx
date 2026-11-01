// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import { BuildingEditor } from "./BuildingEditor";
import { drawLayout } from "./draw";
import { canvasView, type CanvasCamera } from "./geometry";

vi.mock("./draw", () => ({ drawLayout: vi.fn() }));
const building = {
  ...example,
  obstructions: [
    { id: "table", name: "Conference table", x: 18, y: 5, width: 2, height: 1 },
    { id: "cabinet", x: 22, y: 5, width: 1, height: 1 },
  ],
};
let host: HTMLDivElement, root: Root, canvas: HTMLCanvasElement;
const onChange = vi.fn();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  onChange.mockClear();
  vi.mocked(drawLayout).mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<BuildingEditor building={building} onChange={onChange} />),
  );
  canvas = host.querySelector("canvas")!;
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
  canvas.hasPointerCapture = vi.fn(() => false);
  canvas.releasePointerCapture = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function camera(): CanvasCamera {
  return vi.mocked(drawLayout).mock.calls.at(-1)![6]!.camera!;
}
async function point(x: number, y: number, shiftKey = false) {
  const view = canvasView(
    800,
    600,
    building,
    camera(),
    window.devicePixelRatio,
  );
  const event = {
    bubbles: true,
    pointerId: 1,
    button: 0,
    shiftKey,
    clientX: view.x + x * view.scale,
    clientY: view.y + y * view.scale,
  };
  await act(async () =>
    canvas.dispatchEvent(new PointerEvent("pointerdown", event)),
  );
  await act(async () =>
    canvas.dispatchEvent(new PointerEvent("pointerup", event)),
  );
}
async function key(target: HTMLElement, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "f",
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  await act(async () => target.dispatchEvent(event));
  return event;
}
async function click(name: string) {
  const button = [...host.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name,
  )!;
  await act(async () => button.click());
}
async function pan() {
  await act(async () =>
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 2,
        button: 1,
        clientX: 400,
        clientY: 300,
      }),
    ),
  );
  await act(async () =>
    canvas.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 2,
        clientX: 450,
        clientY: 275,
      }),
    ),
  );
  await act(async () =>
    canvas.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        pointerId: 2,
        button: 1,
        clientX: 450,
        clientY: 275,
      }),
    ),
  );
}

it("returns to the saved zoom and pan after repeated focus or deselection without creating building history", async () => {
  await click("Zoom in");
  await pan();
  await point(19, 5.5);
  const before = structuredClone(camera());
  await key(canvas);
  expect(camera()).not.toEqual(before);
  await key(canvas); // Preserve the useful return target if the view is unchanged.
  await key(canvas, { key: "Escape" });
  expect(canvas.dataset.selectedCount).toBe("0");
  expect((await key(canvas, { shiftKey: true })).defaultPrevented).toBe(true);
  expect(camera()).toEqual(before);
  expect((await key(canvas, { shiftKey: true })).defaultPrevented).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!
      .disabled,
  ).toBe(true);
});

it("restores the same world centre after resizing and leaves typing and drawing alone", async () => {
  await click("Zoom in");
  await pan();
  await point(19, 5.5);
  const before = structuredClone(camera());
  const old = canvasView(800, 600, building, before);
  const center = { x: (400 - old.x) / old.scale, y: (300 - old.y) / old.scale };
  await key(canvas);
  const focused = structuredClone(camera());
  await click("Properties");
  const input = host.querySelector<HTMLInputElement>(
    ".object-name-field input",
  )!;
  expect((await key(input, { shiftKey: true })).defaultPrevented).toBe(false);
  expect(camera()).toEqual(focused);
  await click("Walls");
  await click("Straight wall");
  expect((await key(canvas, { shiftKey: true })).defaultPrevented).toBe(false);
  expect(camera()).toEqual(focused);
  await click("Select / move");
  const rect = canvas.getBoundingClientRect();
  canvas.width = 1000;
  canvas.height = 700;
  canvas.getBoundingClientRect = () => ({
    ...rect,
    width: 1000,
    height: 700,
    right: 1000,
    bottom: 700,
  });
  await key(canvas, { shiftKey: true });
  const restored = canvasView(1000, 700, building, camera());
  expect(camera().zoom).toBe(before.zoom);
  expect((500 - restored.x) / restored.scale).toBeCloseTo(center.x);
  expect((350 - restored.y) / restored.scale).toBeCloseTo(center.y);
  expect(onChange).not.toHaveBeenCalled();
});

it("frames one object or an additive group without editing geometry, selection, or history", async () => {
  const before = JSON.stringify(building);
  await point(19, 5.5);
  expect(canvas.dataset.selectedCount).toBe("1");
  expect((await key(canvas)).defaultPrevented).toBe(true);
  let view = canvasView(800, 600, building, camera(), window.devicePixelRatio);
  expect(view.x + 19 * view.scale).toBeCloseTo(400);
  expect(view.y + 5.5 * view.scale).toBeCloseTo(300);
  await click("Fit plan");
  await point(22.5, 5.5, true);
  expect(canvas.dataset.selectedCount).toBe("2");
  await key(canvas);
  view = canvasView(800, 600, building, camera(), window.devicePixelRatio);
  expect(view.x + 20.5 * view.scale).toBeCloseTo(400);
  expect(view.y + 5.5 * view.scale).toBeCloseTo(300);
  expect(canvas.dataset.selectedCount).toBe("2");
  expect(
    host
      .querySelector('aside[aria-label="Element inspector"]')
      ?.hasAttribute("hidden"),
  ).toBe(true);
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!
      .disabled,
  ).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
  expect(JSON.stringify(building)).toBe(before);
});

it("ignores F without selection, with modifiers, in Properties inputs, and while drawing", async () => {
  expect((await key(canvas)).defaultPrevented).toBe(false);
  await point(19, 5.5);
  const before = structuredClone(camera());
  for (const extra of [
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { repeat: true },
  ]) {
    expect((await key(canvas, extra)).defaultPrevented).toBe(false);
    expect(camera()).toEqual(before);
  }
  await click("Properties");
  const input = host.querySelector<HTMLInputElement>(
    ".object-name-field input",
  )!;
  expect((await key(input)).defaultPrevented).toBe(false);
  expect(camera()).toEqual(before);
  await click("Walls");
  await click("Straight wall");
  expect((await key(canvas)).defaultPrevented).toBe(false);
  expect(camera()).toEqual(before);
  expect(onChange).not.toHaveBeenCalled();
});
