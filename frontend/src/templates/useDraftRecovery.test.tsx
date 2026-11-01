// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import { useDraftRecovery } from "./useDraftRecovery";
import {
  DRAFT_STORAGE_KEY,
  DRAFT_DELAY_MS,
  saveRecoveryDraft,
  parseRecoveryDraft,
} from "./draftRecovery";

let root: Root, host: HTMLDivElement;
const apply = vi.fn(() => false);
function Harness({ building = example }: { building?: BuildingScenario }) {
  const recovery = useDraftRecovery(building, JSON.stringify(example), null);
  return (
    <>
      <output>
        {JSON.stringify({
          pending: recovery.pending,
          problem: recovery.problem,
          savedAt: recovery.lastSavedAt,
        })}
      </output>
      <button onClick={() => recovery.restore(apply)}>Restore</button>
      <button onClick={recovery.discard}>Discard</button>
    </>
  );
}
function state() {
  return JSON.parse(host.querySelector("output")!.textContent!);
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
  apply.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(building: BuildingScenario = example) {
  await act(async () => root.render(<Harness building={building} />));
}

it("debounces the latest committed edit and removes its copy when Undo/Save returns to the baseline", async () => {
  await render();
  expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  await render({ ...example, seed: 99 });
  await render({ ...example, seed: 100 });
  await act(async () => vi.advanceTimersByTime(DRAFT_DELAY_MS - 1));
  expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(
    parseRecoveryDraft(localStorage.getItem(DRAFT_STORAGE_KEY)!).building.seed,
  ).toBe(100);
  expect(state().savedAt).toBeTruthy();
  await render(example);
  expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
});

it("flushes a pending edit on page departure without waiting for the timer", async () => {
  await render({ ...example, seed: 101 });
  expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(
    parseRecoveryDraft(localStorage.getItem(DRAFT_STORAGE_KEY)!).building.seed,
  ).toBe(101);
});

it("preserves the pending copy until an explicit decision and keeps it when restore is cancelled", async () => {
  const saved = saveRecoveryDraft(
    localStorage,
    null,
    { ...example, seed: 102 },
    null,
  );
  await render();
  await act(async () => vi.advanceTimersByTime(DRAFT_DELAY_MS * 2));
  expect(state().pending).toBe(true);
  expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBe(saved.raw);
  await act(async () => host.querySelectorAll("button")[0]!.click());
  expect(apply).toHaveBeenCalledOnce();
  expect(state().pending).toBe(true);
  expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBe(saved.raw);
  await act(async () => host.querySelectorAll("button")[1]!.click());
  expect(state().pending).toBe(false);
  expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
});

it("reports failed writes without claiming a successful backup or changing the drawing", async () => {
  const building = { ...example, seed: 103 };
  vi.spyOn(window, "localStorage", "get").mockReturnValue({
    getItem: () => null,
    setItem: () => {
      throw new Error("Storage full");
    },
    removeItem: () => {},
  } as unknown as Storage);
  await render(building);
  await act(async () => vi.advanceTimersByTime(DRAFT_DELAY_MS));
  expect(state().problem).toBe("Storage full");
  expect(state().savedAt).toBeNull();
  expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  expect(building.seed).toBe(103);
});
