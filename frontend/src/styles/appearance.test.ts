import { afterEach, it, expect, vi } from "vitest";
import {
  appearanceOptions,
  parseTheme,
  initialTheme,
  THEME_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
} from "./appearance";
afterEach(() => vi.unstubAllGlobals());
it("offers exactly four appearances and migrates Slate without accepting unknown preferences", () => {
  expect(appearanceOptions).toHaveLength(4);
  for (const [key] of appearanceOptions) expect(parseTheme(key)).toBe(key);
  expect(parseTheme("slate")).toBe("light");
  expect(parseTheme(null)).toBe("blueprint-dark");
  expect(parseTheme("invalid")).toBe("blueprint-dark");
});

it("defaults the canvas to Blueprint Dark and migrates prior preferences without changing their explicit canvas choices", () => {
  const items = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: { getItem: (key: string) => items.get(key) ?? null },
  });
  expect(initialTheme()).toBe("blueprint-dark");
  items.set(LEGACY_THEME_STORAGE_KEY, "dark");
  expect(initialTheme()).toBe("blueprint-dark");
  items.set(LEGACY_THEME_STORAGE_KEY, "blueprint-light");
  expect(initialTheme()).toBe("blueprint-light");
  items.set(THEME_STORAGE_KEY, "dark");
  expect(initialTheme()).toBe("dark");
  items.set(THEME_STORAGE_KEY, "light");
  expect(initialTheme()).toBe("light");
});

it("keeps the default available when local storage is unavailable", () => {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => {
        throw Error("blocked");
      },
    },
  });
  expect(initialTheme()).toBe("blueprint-dark");
});
