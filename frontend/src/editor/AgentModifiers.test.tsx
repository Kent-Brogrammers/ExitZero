// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import { AgentModifiersDialog } from "./AgentModifiers";
import { buildingError } from "./geometry";
import { modifierPresets } from "./agentModifiers";
import type { BuildingScenario } from "../types/simulation";

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(building: BuildingScenario = structuredClone(example)) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(
    function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  );
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.removeAttribute("open");
  });
  host = document.createElement("div");
  document.body.append(host);
  const apply = vi.fn<(next: BuildingScenario) => boolean>(() => true),
    close = vi.fn();
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <AgentModifiersDialog
        building={building}
        onApply={apply}
        onClose={close}
      />,
    ),
  );
  return { apply, close, building };
}
async function click(text: string) {
  await act(async () =>
    [...host!.querySelectorAll("button")]
      .find((b) => b.textContent === text)!
      .click(),
  );
}

it("opens with every personality allowed and saves automatic spawn configuration", async () => {
  const { apply, close } = await render();
  const toggles = [
    ...host!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ];
  expect(toggles).toHaveLength(modifierPresets.length);
  expect(toggles.every((input) => input.checked)).toBe(true);
  expect(host!.querySelector("dialog")!.open).toBe(true);
  expect(host!.textContent).toContain("automatically");
  expect(
    host!.querySelector<HTMLInputElement>(
      '[aria-label="Occupants with a personality (%)"]',
    )!.value,
  ).toBe("30");
  expect(host!.textContent).not.toContain("Apply population modifiers");
  await act(async () =>
    host!
      .querySelector<HTMLInputElement>('[aria-label="Allow Scared"]')!
      .click(),
  );
  expect(apply).not.toHaveBeenCalled();
  await click("Save changes");
  const saved = apply.mock.calls[0]![0] as BuildingScenario;
  expect(saved.spawn_modifier_ids).toHaveLength(modifierPresets.length - 1);
  expect(saved.spawn_modifier_ids).not.toContain("scared");
  expect(saved.personality_fraction).toBe(0.3);
  expect(
    saved.agent_modifiers?.find((m) => m.id === "scared")?.speed_multiplier,
  ).toBe(0.25);
  expect(buildingError(saved)).toBeNull();
  expect(close).toHaveBeenCalledOnce();
});

it("can disable every personality, and cancelling never changes the saved layout", async () => {
  const { apply, close, building } = await render();
  const original = JSON.stringify(building);
  await click("Clear all");
  expect(host!.textContent).toContain("neutral personality");
  await click("Cancel");
  expect(apply).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  expect(JSON.stringify(building)).toBe(original);
});

it("retains a saved allow list and removes old manual groups when saving", async () => {
  const building: BuildingScenario = structuredClone(example);
  building.agent_modifiers = [...modifierPresets];
  building.spawn_modifier_ids = ["calm"];
  const { apply } = await render(building);
  expect(
    [
      ...host!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].filter((input) => input.checked),
  ).toHaveLength(1);
  await click("Clear all");
  await click("Save changes");
  expect(
    (apply.mock.calls[0]![0] as BuildingScenario).spawn_modifier_ids,
  ).toEqual([]);
});
