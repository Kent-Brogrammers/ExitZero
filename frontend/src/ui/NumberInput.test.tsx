// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NumberInput } from "./NumberInput";
import { LengthInput } from "./LengthInput";
import { lengthInputValue, setDisplayUnits } from "../utils/units";

let root: Root, host: HTMLDivElement;
const changed = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setDisplayUnits("imperial");
  changed.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setDisplayUnits("imperial");
  vi.unstubAllGlobals();
});
const input = () => host.querySelector("input")!;
async function type(text: string) {
  await act(async () => {
    input().focus();
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function step(direction: "Increase" | "Decrease") {
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        `[aria-label="${direction} Test value"]`,
      )!
      .click(),
  );
}
async function length(initial = 1, commitOnBlur = false) {
  function Control() {
    const [value, setValue] = useState(initial);
    return (
      <LengthInput
        aria-label="Test value"
        value={value}
        min={0.1}
        max={10}
        commitOnBlur={commitOnBlur}
        onValue={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  await act(async () => root.render(<Control />));
}

it("keeps clearing and partial below-minimum values editable without sending zero or NaN", async () => {
  await length();
  await type("");
  expect(input().value).toBe("");
  expect(changed).not.toHaveBeenCalled();
  await type("0");
  expect(input().value).toBe("0");
  expect(changed).not.toHaveBeenCalled();
  await type("0.5");
  expect(input().value).toBe("0.5");
  expect(changed).toHaveBeenLastCalledWith(0.1524);
  await type("");
  expect(input().value).toBe("");
  await type("12.50");
  expect(input().value).toBe("12.50");
  expect(changed).toHaveBeenLastCalledWith(3.81);
});

it("restores the last valid value on blur and preserves untouched source precision", async () => {
  const original = 1.234567891234;
  await length(original);
  await act(async () => {
    input().focus();
    input().blur();
  });
  expect(changed).not.toHaveBeenCalled();
  await type("");
  await act(async () => input().blur());
  expect(Number(input().value)).toBe(lengthInputValue(original));
  expect(changed).not.toHaveBeenCalled();
  await type("100000");
  expect(changed).not.toHaveBeenCalled();
  await act(async () => input().blur());
  expect(Number(input().value)).toBe(lengthInputValue(original));
});

it.each(["imperial", "metric"] as const)(
  "steps by one displayed unit in %s without snapping to converted minima or losing source precision",
  async (units) => {
    setDisplayUnits(units);
    await length();
    const displayed = Number(input().value);
    await step("Increase");
    expect(Number(input().value)).toBeCloseTo(displayed + 1, 8);
    expect(changed.mock.lastCall![0]).toBeCloseTo(
      units === "imperial" ? 1.3048 : 2,
      12,
    );
    await step("Decrease");
    expect(Number(input().value)).toBe(displayed);
    expect(changed.mock.lastCall![0]).toBeCloseTo(1, 12);
    await act(async () =>
      input().dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      ),
    );
    expect(Number(input().value)).toBeCloseTo(displayed + 1, 8);
  },
);

it("keeps decimal increments relative, bounds buttons, and honors disabled controls", async () => {
  function Control() {
    const [value, setValue] = useState(0.1181);
    return (
      <NumberInput
        aria-label="Test value"
        value={value}
        step={0.01}
        min={0.03280839895}
        max={0.14}
        onValue={setValue}
      />
    );
  }
  await act(async () => root.render(<Control />));
  await step("Increase");
  expect(Number(input().value)).toBe(0.1281);
  await step("Decrease");
  expect(Number(input().value)).toBe(0.1181);
  await step("Increase");
  await step("Increase");
  await step("Increase");
  expect(Number(input().value)).toBe(0.14);
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Increase Test value"]')!
      .disabled,
  ).toBe(true);
  await act(async () =>
    root.render(
      <NumberInput
        aria-label="Test value"
        value={1}
        disabled
        onValue={changed}
      />,
    ),
  );
  await step("Increase");
  expect(changed).not.toHaveBeenCalled();
  expect(input().disabled).toBe(true);
});

it("allows replacing counts while rejecting fractions and respecting the safe integer limit", async () => {
  function Control() {
    const [value, setValue] = useState(42);
    return (
      <NumberInput
        aria-label="Test value"
        value={value}
        integer
        min={0}
        max={Number.MAX_SAFE_INTEGER}
        onValue={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  await act(async () => root.render(<Control />));
  await type("");
  expect(input().value).toBe("");
  await type("12.5");
  expect(changed).not.toHaveBeenCalled();
  await type("0");
  expect(changed).toHaveBeenLastCalledWith(0);
  await step("Increase");
  expect(Number(input().value)).toBe(1);
  await type(String(Number.MAX_SAFE_INTEGER));
  expect(changed).toHaveBeenLastCalledWith(Number.MAX_SAFE_INTEGER);
  await step("Increase");
  expect(Number(input().value)).toBe(Number.MAX_SAFE_INTEGER);
});

it("supports committing window-style edits on blur or Enter and resetting drafts on unit changes", async () => {
  await length(1, true);
  await type("10");
  expect(changed).not.toHaveBeenCalled();
  await act(async () =>
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(changed).toHaveBeenLastCalledWith(3.048);
  await type("");
  await act(async () => setDisplayUnits("metric"));
  expect(Number(input().value)).toBe(3.048);
  expect(changed).toHaveBeenCalledTimes(1);
});
