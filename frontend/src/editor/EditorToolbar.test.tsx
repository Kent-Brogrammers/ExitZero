// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorDrawingRail } from "./EditorDrawingRail";
import { EditorUtilityRail } from "./EditorUtilityRail";

let root: Root, host: HTMLDivElement;
const onTool = vi.fn();
const onUndo = vi.fn();
const onDelete = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  onTool.mockReset();
  onUndo.mockReset();
  onDelete.mockReset();
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
  const result = [...host.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name,
  );
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function drawing() {
  await act(async () =>
    root.render(
      <EditorDrawingRail
        tool="select"
        disabled={false}
        onTool={onTool}
        onOpenPanel={() => {}}
      />,
    ),
  );
}
async function menus(
  showShelter = false,
  hasSelection = false,
  disabled = false,
) {
  await act(async () =>
    root.render(
      <EditorUtilityRail
        disabled={disabled}
        canUndo
        canRedo={false}
        hasSelection={hasSelection}
        tool="select"
        showShelter={showShelter}
        propertiesOpen={false}
        propertiesButton={null}
        onUndo={onUndo}
        onRedo={() => {}}
        onDuplicate={() => {}}
        onDelete={onDelete}
        onTool={onTool}
        onNew={() => {}}
        onImport={() => {}}
        onImportDxf={() => {}}
        onExport={() => {}}
        onProperties={() => {}}
        canvasControls={<p>Drawing area controls</p>}
        drafting={{
          visible: false,
          snap: false,
          spacing: "2ft",
          doorMergeTolerance: 0.1,
        }}
        onDrafting={() => {}}
      />,
    ),
  );
}

it("keeps freehand in Advanced and routes wall and opening choices to the existing tools", async () => {
  await drawing();
  await click("Walls");
  const advanced = host.querySelector("details")!;
  expect(advanced.open).toBe(false);
  expect(advanced.querySelector("button")?.getAttribute("aria-label")).toBe(
    "Freehand curve",
  );
  await act(async () => advanced.querySelector("summary")!.click());
  await click("Freehand curve");
  expect(onTool).toHaveBeenLastCalledWith("wall-freehand");
  expect(host.querySelector(".studio-popover-panel")).toBeNull();
  for (const [name, tool] of [
    ["Door", "door"],
    ["Exit", "exit"],
    ["Window", "window"],
  ]) {
    await click("Openings");
    await click(name!);
    expect(onTool).toHaveBeenLastCalledWith(tool);
  }
});

it("preserves furniture and people choices while removing unsupported object placeholders", async () => {
  await drawing();
  await click("Objects");
  expect(host.textContent).not.toContain("Collision unsupported");
  expect(host.querySelector('button[aria-label="Circle"]')).toBeNull();
  expect(host.querySelector('button[aria-label="Ellipse"]')).toBeNull();
  expect(button("Chair").textContent).toContain("Solid rectangular blocker");
  await click("Chair");
  expect(onTool).toHaveBeenLastCalledWith("furniture-chair");
  for (const [name, tool] of [
    ["Draw Zone", "spawn"],
    ["Fill Room", "spawn-room"],
    ["Place occupant", "occupant"],
  ]) {
    await click("People");
    await click(name!);
    expect(onTool).toHaveBeenLastCalledWith(tool);
  }
});

it("restores stair insertion, gates shelter insertion, and guards unavailable edit actions", async () => {
  await menus();
  await click("Insert");
  expect(host.textContent).not.toContain("Tornado shelter zone");
  await act(async () => button("Insert").click());
  await menus(true);
  await click("Insert");
  const stair = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Stair area"),
  )!;
  await act(async () => stair.click());
  expect(onTool).toHaveBeenLastCalledWith("stairs");
  await click("Insert");
  const shelter = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Tornado shelter zone"),
  )!;
  await act(async () => shelter.click());
  expect(onTool).toHaveBeenLastCalledWith("tornado-zone");
  await click("Edit");
  expect(button("Redo").disabled).toBe(true);
  expect(button("Delete selection").disabled).toBe(true);
  await click("Delete selection");
  expect(onDelete).not.toHaveBeenCalled();
  await click("Undo");
  expect(onUndo).toHaveBeenCalledOnce();
  await menus(true, true);
  await click("Edit");
  await click("Delete selection");
  expect(onDelete).toHaveBeenCalledOnce();
});
