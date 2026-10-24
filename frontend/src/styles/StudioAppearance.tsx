import {
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import {
  AppearanceContext,
  appearanceOptions,
  initialTheme,
  THEME_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
  type StudioTheme,
} from "./appearance";

export function StudioAppearance({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<StudioTheme>(initialTheme);
  useLayoutEffect(() => {
    document.documentElement.dataset.studioTheme = "dark";
    document.documentElement.dataset.canvasTheme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* Appearance still works when browser storage is unavailable. */
    }
  }, [theme]);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (
        event.key === THEME_STORAGE_KEY ||
        event.key === LEGACY_THEME_STORAGE_KEY ||
        event.key === null
      )
        setTheme(initialTheme());
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, []);
  return (
    <AppearanceContext value={{ theme, setTheme }}>
      {children}
    </AppearanceContext>
  );
}

export function AppearanceSelector() {
  const { theme, setTheme } = useContext(AppearanceContext);
  return (
    <div>
      <label className="appearance-setting">
        Canvas appearance
        <select
          aria-label="Canvas appearance"
          value={theme}
          onChange={(event) => setTheme(event.target.value as StudioTheme)}
        >
          {appearanceOptions.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p className="note">
        The Studio shell stays dark; appearance changes apply only to floor-plan
        canvases.
      </p>
      {theme.startsWith("blueprint") && (
        <p className="note">
          Architectural wall outlines and schematic door swings. Collision still
          uses full wall thickness and the recorded openings; stair areas are
          walkable markers.
        </p>
      )}
    </div>
  );
}
