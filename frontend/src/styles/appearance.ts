export const STUDIO_THEME = "dark";
export const CANVAS_THEME = "blueprint-dark";
export const THEME_STORAGE_KEY = "exitzero.studio.canvas-appearance";
export const LEGACY_THEME_STORAGE_KEY = "exitzero.studio.appearance";

// Keep the shared drawing hook stable for editor, playback and analytics.
export function useStudioTheme() {
  return CANVAS_THEME;
}
