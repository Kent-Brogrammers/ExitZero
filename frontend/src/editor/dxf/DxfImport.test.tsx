// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import example from "../../../../shared/examples/building.json";
import type { BuildingScenario } from "../../types/simulation";
import DxfImport from "./DxfImport";
import { parseDxf, type DxfDrawing } from "./convert";
import { buildingError } from "../geometry";
import source from "./fixtures/classroom-and-resource-store-70-m2.dxf?raw";
let root: Root, host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // Exercise real DXF parsing; only the worker transport and canvas are stubbed.
  vi.stubGlobal(
    "Worker",
    class {
      onmessage?: (event: { data: { drawing: DxfDrawing } }) => void;
      postMessage(text: string) {
        queueMicrotask(() =>
          this.onmessage?.({ data: { drawing: parseDxf(text) } }),
        );
      }
      terminate() {}
    },
  );
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

it("uploads the classroom, prefills footprint detection, permits overrides and applies the reviewed layout", async () => {
  const base: BuildingScenario = {
    ...structuredClone(example),
    placed_occupants: [{ id: "old-person", x: 25, y: 15 }],
  };
  const before = structuredClone(base);
  const onApply = vi.fn<(building: BuildingScenario) => boolean>(() => true);
  const dialog = createRef<HTMLDialogElement>();
  await act(async () =>
    root.render(<DxfImport base={base} onApply={onApply} dialogRef={dialog} />),
  );
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    value: [
      { name: "classroom.dxf", size: source.length, text: async () => source },
    ],
  });
  await act(async () =>
    input.dispatchEvent(new Event("change", { bubbles: true })),
  );

  const solid = [...host.querySelectorAll("label")]
    .find((label) =>
      label.textContent?.includes("Closed rectangles are solid walls"),
    )!
    .querySelector<HTMLInputElement>("input")!;
  expect(solid.checked).toBe(true);
  const canvas = host.querySelector("canvas")!;
  expect(canvas.getAttribute("aria-label")).toContain(
    "7 walls, 3 door candidates and 1 suggested exits",
  );
  const roles = [
    ...host.querySelectorAll<HTMLSelectElement>(
      'select[aria-label^="Role for"]',
    ),
  ];
  expect(roles).toHaveLength(9);
  expect(roles.filter((role) => role.value === "window")).toHaveLength(5);

  await act(async () => solid.click());
  expect(canvas.getAttribute("aria-label")).toContain("40 walls");
  await act(async () => solid.click());
  const windowRole = [
    ...host.querySelectorAll<HTMLSelectElement>("select"),
  ].find((select) => select.value === "window")!;
  await act(async () => {
    windowRole.value = "closed";
    windowRole.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const apply = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Use detected layout in editor",
  )!;
  expect(apply.disabled).toBe(false);
  await act(async () => apply.click());
  expect(onApply).toHaveBeenCalledOnce();
  const imported = onApply.mock.calls[0]![0] as BuildingScenario;
  expect(imported.walls).toHaveLength(7);
  expect(imported.doors).toHaveLength(3);
  expect(imported.exits).toHaveLength(1);
  expect(imported.windows).toHaveLength(4);
  expect(imported.placed_occupants).toEqual([]);
  expect(buildingError(imported, false)).toBeNull();
  expect(base).toEqual(before);
});
