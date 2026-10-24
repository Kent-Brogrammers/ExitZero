import {
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import {
  AppearanceContext,
  initialTheme,
  THEME_STORAGE_KEY,
  type StudioTheme,
} from "./appearance";

export function StudioAppearance({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<StudioTheme>(initialTheme);
  useLayoutEffect(() => {
    document.documentElement.dataset.studioTheme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* Appearance still works when browser storage is unavailable. */
    }
  }, [theme]);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null)
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
    <label className="appearance-setting">
      Appearance
      <select
        aria-label="Studio appearance"
        value={theme}
        onChange={(event) => setTheme(event.target.value as StudioTheme)}
      >
        <option value="dark">Studio Dark</option>
        <option value="slate">Studio Slate</option>
      </select>
    </label>
  );
}
