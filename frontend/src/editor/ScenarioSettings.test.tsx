// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import { DisasterControls } from "./DisasterControls";
import type { BuildingScenario } from "../types/simulation";

let root: Root, host: HTMLDivElement;
const change = vi.fn<(next: BuildingScenario) => boolean | void>();
const locate = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  change.mockReset();
  locate.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === label)!
      .click(),
  );
}
async function choose(label: string) {
  await act(async () =>
    host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!.click(),
  );
}
async function mount() {
  const building = structuredClone(example);
  await act(async () =>
    root.render(
      <DisasterControls
        building={building}
        onChange={change}
        onLocate={locate}
      />,
    ),
  );
  return building;
}

it("keeps scenario changes local until Apply and emits one independent update", async () => {
  const original = await mount();
  expect(host.querySelector(".scenario-picker")).toBeNull();
  await click("Scenario");
  expect(host.querySelector("dialog")!.open).toBe(true);
  await choose("Fire evacuation");
  await choose("Gas leak evacuation");
  expect(change).not.toHaveBeenCalled();
  expect(original).not.toHaveProperty("disaster");
  await click("Apply");
  expect(change).toHaveBeenCalledTimes(1);
  expect(change.mock.calls[0]![0].disaster?.kind).toBe("gas_leak");
  expect(host.querySelector("dialog")).toBeNull();
  expect(locate).not.toHaveBeenCalled();
});

it("Cancel, Escape and close discard local edits, and reopening starts with the saved scenario", async () => {
  await mount();
  for (const dismissal of ["Cancel", "Escape", "Close"]) {
    await click("Scenario");
    await choose("Fire evacuation");
    if (dismissal === "Escape")
      await act(async () =>
        host
          .querySelector("dialog")!
          .dispatchEvent(new Event("cancel", { cancelable: true })),
      );
    else if (dismissal === "Close")
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            '[aria-label="Close scenario settings"]',
          )!
          .click(),
      );
    else await click("Cancel");
    expect(change).not.toHaveBeenCalled();
    expect(host.querySelector("dialog")).toBeNull();
  }
  await click("Scenario");
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="Baseline evacuation"]')!
      .checked,
  ).toBe(true);
});

it("applies before canvas placement and keeps a rejected edit open", async () => {
  await mount();
  await click("Scenario");
  await choose("Fire evacuation");
  change.mockReturnValueOnce(false);
  await click("Apply");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelector("dialog")!.open).toBe(true);
  expect(locate).not.toHaveBeenCalled();
  await click("Apply & place hazard on plan");
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  expect(locate).toHaveBeenCalledOnce();
  expect(host.querySelector("dialog")).toBeNull();
  expect(change.mock.invocationCallOrder.at(-1)!).toBeLessThan(
    locate.mock.invocationCallOrder[0]!,
  );
});
