import { useLayoutEffect, type ReactNode } from "react";
import {
  STUDIO_THEME,
  CANVAS_THEME,
  THEME_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
} from "./appearance";

export function StudioAppearance({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    document.documentElement.dataset.studioTheme = STUDIO_THEME;
    document.documentElement.dataset.canvasTheme = CANVAS_THEME;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, CANVAS_THEME);
      window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, STUDIO_THEME);
    } catch {
      /* The fixed appearance also works without browser storage. */
    }
  }, []);
  return children;
}

export function AppearanceSelector() {
  return (
    <dl className="settings-values">
      <div>
        <dt>Studio</dt>
        <dd>Black</dd>
      </div>
      <div>
        <dt>Floor plan</dt>
        <dd>Blue blueprint</dd>
      </div>
    </dl>
  );
}
