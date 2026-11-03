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
  await click("Place hazard on plan");
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

it.each(["Fire evacuation", "Gas leak evacuation", "Indoor shelter response"])(
  "places %s with defaults without requiring parameter entry",
  async (kind) => {
    await mount();
    await click("Scenario");
    await choose(kind);
    expect(host.querySelector('[aria-label="Hazard radius"]')).toBeNull();
    expect(
      host.querySelector('[aria-label="Scenario random seed"]'),
    ).toBeNull();
    await click("Place hazard on plan");
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    });
    expect(change).toHaveBeenCalledOnce();
    expect(change.mock.calls[0]![0].disaster?.dynamics?.enabled).toBe(true);
    expect(locate).toHaveBeenCalledOnce();
    expect(host.querySelector("dialog")).toBeNull();
  },
);

it("keeps parameter editing available from the keyboard-accessible picker", async () => {
  await mount();
  await click("Scenario");
  await choose("Fire evacuation");
  await click("Edit parameters");
  expect(host.querySelector('[aria-label="Hazard radius"]')).not.toBeNull();
  expect(host.textContent).toContain("Spread settings");
  await click("Cancel");
  expect(change).not.toHaveBeenCalled();
});

async function editNumber(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

it("lets users replace hazard values and applies exact displayed-unit steps without a minimum snap", async () => {
  await mount();
  await click("Scenario");
  await choose("Fire evacuation");
  await click("Edit parameters");
  const radius = await editNumber("Hazard radius", "");
  expect(radius.value).toBe("");
  await editNumber("Hazard radius", "12.5");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        '[aria-label="Increase Hazard radius"]',
      )!
      .click(),
  );
  expect(Number(radius.value)).toBe(13.5);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        '[aria-label="Decrease Hazard radius"]',
      )!
      .click(),
  );
  expect(Number(radius.value)).toBe(12.5);
  const growth = host.querySelector<HTMLInputElement>(
    '[aria-label="Growth rate (ft/s)"]',
  )!;
  const initialGrowth = Number(growth.value);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        '[aria-label="Increase Growth rate (ft/s)"]',
      )!
      .click(),
  );
  expect(Number(growth.value)).toBeCloseTo(initialGrowth + 0.01, 8);
  const patches = await editNumber("Maximum patches", "");
  expect(patches.value).toBe("");
  await editNumber("Maximum patches", "12");
  await editNumber("Scenario random seed", "");
  await editNumber("Scenario random seed", "123");
  expect(change).not.toHaveBeenCalled();
  await click("Apply");
  const saved = change.mock.calls[0]![0];
  expect(saved.disaster!.radius).toBeCloseTo(3.81, 12);
  expect(saved.disaster!.dynamics!.growth_rate).toBeCloseTo(
    0.036 + 0.003048,
    12,
  );
  expect(saved.disaster!.dynamics!.max_patches).toBe(12);
  expect(saved.seed).toBe(123);
  expect(host.querySelector("dialog")).toBeNull();
});

it("uses fractional time steps and whole-degree steps in tornado controls", async () => {
  await mount();
  await click("Scenario");
  await choose("Indoor shelter response");
  await click("Edit parameters");
  const interval = await editNumber("Change direction every (s)", "");
  expect(interval.value).toBe("");
  await editNumber("Change direction every (s)", "2.5");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        '[aria-label="Increase Change direction every (s)"]',
      )!
      .click(),
  );
  expect(Number(interval.value)).toBe(2.75);
  const turn = await editNumber("Turning speed (deg/s)", "90");
  await act(async () =>
    turn.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  expect(Number(turn.value)).toBe(89);
  await click("Apply");
  const dynamics = change.mock.calls[0]![0].disaster!.dynamics!;
  expect(dynamics.wander_interval_seconds).toBe(2.75);
  expect(dynamics.turn_rate_degrees).toBe(89);
});
