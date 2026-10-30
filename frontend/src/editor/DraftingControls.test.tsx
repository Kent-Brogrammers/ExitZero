// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DraftingControls } from "./DraftingControls";
import { DRAFTING_STORAGE_KEY, useDraftingPreferences } from "./drafting";

let root: Root, host: HTMLDivElement;
function Harness() {
  const [preferences, setPreferences] = useDraftingPreferences();
  return (
    <DraftingControls preferences={preferences} onChange={setPreferences} />
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
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
function checkbox(text: string) {
  return [...host.querySelectorAll("label")]
    .find((label) => label.textContent?.trim() === text)!
    .querySelector<HTMLInputElement>("input")!;
}

it("migrates legacy preferences and persists wall snapping independently of the grid", async () => {
  localStorage.setItem(
    DRAFTING_STORAGE_KEY,
    JSON.stringify({
      visible: false,
      snap: true,
      spacing: "5ft",
      doorMergeTolerance: 0.05,
    }),
  );
  await act(async () => root.render(<Harness />));
  expect(checkbox("Snap to wall endpoints, corners & segments").checked).toBe(
    true,
  );
  await act(async () =>
    checkbox("Snap to wall endpoints, corners & segments").click(),
  );
  expect(checkbox("Snap to Grid").checked).toBe(true);
  expect(checkbox("Show grid").checked).toBe(false);
  expect(JSON.parse(localStorage.getItem(DRAFTING_STORAGE_KEY)!)).toEqual({
    visible: false,
    snap: true,
    snapEndpoints: false,
    measurements: { walls: false, doors: true, windows: true, exits: true },
    declutterLabels: true,
    spacing: "5ft",
    doorMergeTolerance: 0.05,
  });
  await act(async () => root.render(<Harness key="reload" />));
  expect(checkbox("Snap to wall endpoints, corners & segments").checked).toBe(
    false,
  );
  await act(async () => checkbox("Snap to Grid").click());
  expect(checkbox("Snap to wall endpoints, corners & segments").checked).toBe(
    false,
  );
});

it("saves any measurement combination independently of grid and snapping settings", async () => {
  await act(async () => root.render(<Harness />));
  expect(checkbox("Walls").checked).toBe(false);
  for (const label of ["Doors", "Windows", "Exits"])
    expect(checkbox(label).checked).toBe(true);
  await act(async () => checkbox("Windows").click());
  await act(async () => checkbox("Exits").click());
  expect(checkbox("Doors").checked).toBe(true);
  expect(checkbox("Walls").checked).toBe(false);
  await act(async () => checkbox("Walls").click());
  const saved = JSON.parse(localStorage.getItem(DRAFTING_STORAGE_KEY)!);
  expect(saved.measurements).toEqual({
    walls: true,
    doors: true,
    windows: false,
    exits: false,
  });
  expect(saved.visible).toBe(false);
  expect(saved.snap).toBe(false);
  expect(saved.snapEndpoints).toBe(true);
  expect(checkbox("Reduce label clutter").checked).toBe(true);
  await act(async () => checkbox("Reduce label clutter").click());
  await act(async () => root.render(<Harness key="refresh-measurements" />));
  expect(checkbox("Reduce label clutter").checked).toBe(false);
  for (const label of ["Walls", "Doors"])
    expect(checkbox(label).checked).toBe(true);
  for (const label of ["Windows", "Exits"])
    expect(checkbox(label).checked).toBe(false);
});

it("keeps drawing preferences usable when browser storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Storage disabled");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage disabled");
  });
  await act(async () => root.render(<Harness />));
  expect(checkbox("Snap to wall endpoints, corners & segments").checked).toBe(
    true,
  );
  await act(async () =>
    checkbox("Snap to wall endpoints, corners & segments").click(),
  );
  expect(checkbox("Snap to wall endpoints, corners & segments").checked).toBe(
    false,
  );
  expect(checkbox("Snap to Grid").checked).toBe(false);
});
