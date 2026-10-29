// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import { BuildingEditor } from "./BuildingEditor";

vi.mock("./draw", () => ({ drawLayout: vi.fn() }));

it("edits a shelter's maximum as a person count and keeps invalid edits out of the layout", async () => {
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
    tornado_zones: [{ id: "safe", x: 20, y: 10, width: 3, height: 3 }],
  };
  const changed = vi.fn();
  function Editor() {
    const [building, setBuilding] = useState(initial);
    return (
      <BuildingEditor
        building={building}
        onChange={(next) => {
          changed(next);
          setBuilding(next);
        }}
      />
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Editor />));
    const select = host.querySelector<HTMLSelectElement>(
      '[aria-label="Selected element"]',
    )!;
    await act(async () => {
      select.value = "tornado_zones:safe";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const capacityInput = () =>
      [...host.querySelectorAll("label")]
        .find((label) => label.textContent?.trim() === "Maximum occupants")!
        .querySelector("input")!;
    expect(capacityInput().valueAsNumber).toBe(50);
    expect(capacityInput().step).toBe("1");
    for (const value of ["12", "0", "1.5"]) {
      await act(async () => {
        capacityInput().value = value;
        capacityInput().dispatchEvent(
          new FocusEvent("focusout", { bubbles: true }),
        );
      });
    }
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0]![0].tornado_zones[0].max_occupants).toBe(12);
    expect(capacityInput().valueAsNumber).toBe(12);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "whole number",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
