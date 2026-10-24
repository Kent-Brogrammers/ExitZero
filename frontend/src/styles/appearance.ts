import { createContext, useContext } from "react";

export const appearanceOptions = [
  ["dark", "Studio Dark"],
  ["light", "Studio Light"],
  ["blueprint-dark", "Blueprint Dark"],
  ["blueprint-light", "Blueprint Light"],
] as const;
export type StudioTheme = (typeof appearanceOptions)[number][0];
export function parseTheme(value: string | null): StudioTheme {
  if (value === "slate") return "light";
  return appearanceOptions.some(([key]) => key === value)
    ? (value as StudioTheme)
    : "dark";
}
export const THEME_STORAGE_KEY = "exitzero.studio.appearance";
export const AppearanceContext = createContext<{
  theme: StudioTheme;
  setTheme: (theme: StudioTheme) => void;
}>({ theme: "dark", setTheme: () => {} });
export function useStudioTheme() {
  return useContext(AppearanceContext).theme;
}
export function initialTheme(): StudioTheme {
  try {
    return parseTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}
