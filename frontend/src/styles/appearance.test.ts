import { it, expect } from "vitest";
import { appearanceOptions, parseTheme } from "./appearance";
it("offers exactly four appearances and migrates Slate without accepting unknown preferences", () => {
  expect(appearanceOptions).toHaveLength(4);
  for (const [key] of appearanceOptions) expect(parseTheme(key)).toBe(key);
  expect(parseTheme("slate")).toBe("light");
  expect(parseTheme(null)).toBe("dark");
  expect(parseTheme("invalid")).toBe("dark");
});
