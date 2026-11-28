// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TracingImageDialog } from "./TracingImageDialog";
import type { TracingAsset, TracingConfig } from "./tracing";
import { setDisplayUnits, toMetres } from "../utils/units";

let host: HTMLDivElement, root: Root;
const apply = vi.fn(),
  close = vi.fn();
const asset: TracingAsset = {
  id: "plan",
  name: "classroom.png",
  blob: new Blob(),
  url: "blob:plan",
  image: {} as HTMLImageElement,
  width: 1000,
  height: 500,
};
const initial: TracingConfig = {
  width: 10,
  x: 0,
  y: 0,
  opacity: 0.3,
  visible: true,
  sizing: "fitted",
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setDisplayUnits("imperial");
  apply.mockClear();
  close.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function mount(config = initial, disabled = false) {
  await act(async () =>
    root.render(
      <TracingImageDialog
        source={{ asset, config }}
        disabled={disabled}
        onApply={apply}
        onClose={close}
      />,
    ),
  );
}
function button(name: string) {
  return [...host.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name,
  )!;
}
async function input(label: string, value: string) {
  await act(async () => {
    const field = [...host.querySelectorAll("label")]
      .find((el) => el.textContent?.startsWith(label))!
      .querySelector("input")!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("opens ready to use with optional image controls and no A/B setup", async () => {
  await mount();
  expect(host.querySelector("svg")).toBeNull();
  expect(host.textContent).not.toMatch(/Known distance|Mark A|endpoint/);
  expect(host.textContent).toContain("Fitted size, not measured");
  expect(button("Apply changes").disabled).toBe(false);
  expect(apply).not.toHaveBeenCalled();
});
it("applies optional width and opacity changes locally in canonical metres", async () => {
  await mount();
  await input("Image width", "40");
  await input("Image opacity", "55");
  expect(apply).not.toHaveBeenCalled();
  await act(async () => button("Apply changes").click());
  expect(apply.mock.calls[0]![0]).toEqual({
    asset,
    config: {
      ...initial,
      width: toMetres(40),
      opacity: 0.55,
      sizing: "custom",
    },
  });
  expect(initial.width).toBe(10);
  expect(close).toHaveBeenCalledOnce();
});
it("preserves an untouched precise image width when units change", async () => {
  const config = { ...initial, width: 3.048123456789 };
  await mount(config);
  await act(async () => setDisplayUnits("metric"));
  await act(async () => button("Apply changes").click());
  expect(apply.mock.calls[0]![0].config.width).toBe(config.width);
});
it.each(["Cancel", "Escape", "Close tracing image"])(
  "discards optional image edits on %s",
  async (dismissal) => {
    await mount();
    await input("Image width", "25");
    if (dismissal === "Escape")
      await act(async () =>
        host
          .querySelector("dialog")!
          .dispatchEvent(new Event("cancel", { cancelable: true })),
      );
    else await act(async () => button(dismissal).click());
    expect(apply).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  },
);
it("prevents applying invalid image sizes or changes during a simulation", async () => {
  await mount();
  await input("Image width", "0");
  expect(button("Apply changes").disabled).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(host);
  await mount(initial, true);
  expect(button("Apply changes").disabled).toBe(true);
});
