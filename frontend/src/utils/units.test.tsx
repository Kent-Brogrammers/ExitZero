import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import { LengthInput } from "../ui/LengthInput";
import { buildingError } from "../editor/geometry";
import {
  FOOT_METRES,
  toFeet,
  toMetres,
  lengthInputValue,
  lengthFromInput,
  formatLength,
  formatDimensions,
  getDisplayUnits,
  setDisplayUnits,
  subscribeDisplayUnits,
  UNITS_STORAGE_KEY,
} from "./units";

afterEach(() => setDisplayUnits("imperial"));

describe("measurement preference", () => {
  it("converts metric fields and labels together and preserves untouched precision in either mode", () => {
    for (const units of ["metric", "imperial"] as const) {
      setDisplayUnits(units);
      for (const original of [0, 0.1, 1 / 3, 1.234567891234, 1000])
        expect(lengthFromInput(lengthInputValue(original), original)).toBe(
          original,
        );
    }
    setDisplayUnits("metric");
    expect(formatLength(2)).toBe("2 m");
    expect(formatDimensions(30, 20)).toBe("30 × 20 m");
    expect(lengthFromInput(3.048, 1)).toBe(3.048);
    const html = renderToStaticMarkup(
      <LengthInput value={8} min={0} max={1000} onValue={() => {}} />,
    );
    expect(html).toContain('value="8"');
    expect(html).toContain('max="1000"');
    setDisplayUnits("imperial");
    expect(lengthFromInput(10, 1)).toBe(3.048);
  });

  it("notifies displays and saves only the preference, while unavailable storage stays usable", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { setItem } });
    const listener = vi.fn();
    const unsubscribe = subscribeDisplayUnits(listener);
    try {
      setDisplayUnits("metric");
      expect(getDisplayUnits()).toBe("metric");
      expect(setItem).toHaveBeenCalledWith(UNITS_STORAGE_KEY, "metric");
      expect(listener).toHaveBeenCalledTimes(1);
      setItem.mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
      expect(() => setDisplayUnits("imperial")).not.toThrow();
      expect(getDisplayUnits()).toBe("imperial");
    } finally {
      unsubscribe();
      vi.unstubAllGlobals();
    }
  });
});

describe("feet display over unchanged metre contracts", () => {
  it("converts distances and rates with the exact international foot", () => {
    expect(FOOT_METRES).toBe(0.3048);
    expect(toMetres(10)).toBe(3.048);
    expect(toFeet(3.048)).toBe(10);
    expect(toMetres(toFeet(1.23456789))).toBeCloseTo(1.23456789, 12);
    expect(formatLength(2)).toBe("6.6 ft");
    expect(formatDimensions(30, 20)).toBe("98.4 × 65.6 ft");
    expect(formatLength(0)).toBe("0 ft");
  });

  it("preserves exact original values when an untouched rounded field is blurred", () => {
    for (const original of [0, 0.1, 1 / 3, 1.234567891234, 1000]) {
      expect(lengthFromInput(lengthInputValue(original), original)).toBe(
        original,
      );
    }
    expect(lengthFromInput(10, 1)).toBe(3.048);
    expect(lengthFromInput(0, 1)).toBe(0);
  });

  it("renders awareness/radius bounds in feet and keeps high precision for DXF scales", () => {
    const html = renderToStaticMarkup(
      <LengthInput
        aria-label="Sight range (ft)"
        value={8}
        min={0}
        max={1000}
        onValue={() => {}}
      />,
    );
    expect(html).toContain('value="26.2467"');
    expect(html).toContain(`max="${toFeet(1000)}"`);
    const scale = 0.001;
    expect(lengthInputValue(scale, 8)).toBe(0.00328084);
    expect(lengthFromInput(0.00328084, scale, 8)).toBe(scale);
  });

  it("does not rescale a building or its API serialization when rendering units", () => {
    const building = structuredClone(example),
      json = JSON.stringify(building);
    formatDimensions(building.width, building.height);
    setDisplayUnits("metric");
    expect(formatDimensions(building.width, building.height)).toBe("30 × 20 m");
    for (const wall of building.walls) formatLength(wall.thickness);
    expect(JSON.stringify(building)).toBe(json);
    expect(buildingError(building)).toBeNull();
    expect(JSON.parse(json).width).toBe(30);
  });
});
