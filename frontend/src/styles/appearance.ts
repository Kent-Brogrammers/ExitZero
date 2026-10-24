import { createContext, useContext } from "react";

export type StudioTheme = "dark" | "slate";
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
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "slate"
      ? "slate"
      : "dark";
  } catch {
    return "dark";
  }
}
