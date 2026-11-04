// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import { BuildingEditor } from "./BuildingEditor";
import { buildingError } from "./geometry";

vi.mock("./draw", () => ({ drawLayout: vi.fn() }));
let host: HTMLDivElement, root: Root, latest: BuildingScenario;
const change = vi.fn();
function fixture(): BuildingScenario {
  return {
    ...structuredClone(example),
    spawn_zones: [],
    obstructions: [
      {
        id: "table",
        name: "Conference table",
        x: 8,
        y: 7,
        width: 3.2,
        height: 1.6,
      },
    ],
  };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  change.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function button(name: string) {
  const b = [...host.querySelectorAll("button")].find(
    (el) => (el.getAttribute("aria-label") ?? el.textContent?.trim()) === name,
  );
  expect(b, `Missing ${name}`).toBeDefined();
  return b!;
}
const click = async (name: string) => {
  await act(async () => button(name).click());
};
const dialog = () =>
  host.querySelector<HTMLDialogElement>(".occupant-layout-dialog");
async function mount() {
  latest = fixture();
  function Editor() {
    const [building, setBuilding] = useState(latest);
    return (
      <BuildingEditor
        building={building}
        onChange={(next) => {
          latest = next;
          change(next);
          setBuilding(next);
        }}
      />
    );
  }
  await act(async () => root.render(<Editor />));
}
async function selectObject() {
  await click("Properties");
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>(
      '[aria-label="Selected element"]',
    )!;
    select.value = "obstructions:table";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function setCount(value: string) {
  await act(async () => {
    const input = dialog()!.querySelector<HTMLInputElement>(
      'input[type="number"]',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("previews without mutation, applies one valid batch, and restores exact JSON/IDs with one Undo and Redo", async () => {
  await mount();
  const original = JSON.stringify(latest);
  await selectObject();
  await click("Place people around object…");
  expect(dialog()?.open).toBe(true);
  expect(dialog()?.textContent).toContain("6 people ready");
  expect(change).not.toHaveBeenCalled();
  expect(JSON.stringify(latest)).toBe(original);
  await click("Add people");
  expect(dialog()).toBeNull();
  expect(change).toHaveBeenCalledTimes(1);
  expect(latest.placed_occupants).toHaveLength(6);
  expect(buildingError(JSON.parse(JSON.stringify(latest)))).toBeNull();
  const placed = JSON.stringify(latest);
  expect(host.querySelector("#editor-properties")?.hasAttribute("hidden")).toBe(
    true,
  );
  expect(
    host
      .querySelector("canvas[data-selected-count]")
      ?.getAttribute("data-selected-count"),
  ).toBe("6");
  await click("Undo");
  expect(JSON.stringify(latest)).toBe(original);
  expect(button("Undo").disabled).toBe(true);
  await click("Redo");
  expect(JSON.stringify(latest)).toBe(placed);
});

it("keeps count/sides local, prevents partial application, and discards Cancel/Escape/X edits", async () => {
  await mount();
  await selectObject();
  const original = JSON.stringify(latest);
  for (const dismissal of ["Cancel", "Escape", "Close occupant layout"]) {
    await click("Place people around object…");
    await setCount("100");
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toMatch(
      /clear positions for 100/,
    );
    expect(button("Add people").disabled).toBe(true);
    await setCount("4");
    await act(async () => {
      const select = dialog()!.querySelector("select")!;
      select.value = "horizontal";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      dialog()?.querySelector("canvas")?.getAttribute("aria-label"),
    ).toContain("4 new starting positions");
    if (dismissal === "Escape")
      await act(async () =>
        dialog()!.dispatchEvent(new Event("cancel", { cancelable: true })),
      );
    else await click(dismissal);
    expect(dialog()).toBeNull();
    expect(JSON.stringify(latest)).toBe(original);
    expect(change).not.toHaveBeenCalled();
  }
});

it("exposes the People action only as available for one selected object and uses the same modal", async () => {
  await mount();
  await click("People");
  expect(
    button(
      "Around selected object…Select one rectangular object, table or desk first",
    ).disabled,
  ).toBe(true);
  await click("People");
  await selectObject();
  await click("People");
  const action = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Around selected object…"),
  )!;
  expect(action.disabled).toBe(false);
  await act(async () => action.click());
  expect(dialog()?.open).toBe(true);
  expect(host.querySelector(".studio-popover-panel")).toBeNull();
  expect(change).not.toHaveBeenCalled();
});

it("refuses to overwrite a newer building while a preview is open", async () => {
  const source = fixture();
  await act(async () =>
    root.render(<BuildingEditor building={source} onChange={change} />),
  );
  await selectObject();
  await click("Place people around object…");
  const newer = structuredClone(source);
  newer.seed = 99;
  await act(async () =>
    root.render(<BuildingEditor building={newer} onChange={change} />),
  );
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
    "layout changed",
  );
  expect(button("Add people").disabled).toBe(true);
  await click("Add people");
  expect(change).not.toHaveBeenCalled();
  expect(newer.seed).toBe(99);
});
