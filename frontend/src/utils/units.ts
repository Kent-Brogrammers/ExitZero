// Display conversion only. Building JSON, geometry and simulation remain in metres.
export type DisplayUnits = "imperial" | "metric";
export const UNITS_STORAGE_KEY = "exitzero.studio.units";
const listeners = new Set<() => void>();
let displayUnits: DisplayUnits = "imperial";
try {
  if (window.localStorage.getItem(UNITS_STORAGE_KEY) === "metric")
    displayUnits = "metric";
} catch {
  /* Imperial remains the default without browser storage (including SSR). */
}
export const getDisplayUnits = () => displayUnits;
export function subscribeDisplayUnits(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setDisplayUnits(units: DisplayUnits) {
  if (units !== "imperial" && units !== "metric") return;
  displayUnits = units;
  try {
    window.localStorage.setItem(UNITS_STORAGE_KEY, units);
  } catch {
    /* Display preferences still work in memory. */
  }
  listeners.forEach((listener) => listener());
}
export const lengthUnit = () => (displayUnits === "metric" ? "m" : "ft");
export const lengthUnitName = () =>
  displayUnits === "metric" ? "Meters" : "Feet";
export const FOOT_METRES = 0.3048;
export const toFeet = (metres: number) => metres / FOOT_METRES;
export const toMetres = (feet: number) => feet * FOOT_METRES;
export const toDisplayLength = (metres: number) =>
  displayUnits === "metric" ? metres : toFeet(metres);
export const lengthInputValue = (metres: number, precision = 4) =>
  Number(toDisplayLength(metres).toFixed(precision));

/** Blurring an untouched rounded field must preserve the exact stored geometry. */
export function lengthFromInput(
  value: number,
  original: number,
  precision = 4,
) {
  return value === lengthInputValue(original, precision)
    ? original
    : displayUnits === "metric"
      ? value
      : toMetres(value);
}

export const formatLength = (metres: number, precision = 1) =>
  `${lengthInputValue(metres, precision)} ${lengthUnit()}`;
export const formatDimensions = (
  width: number,
  height: number,
  precision = 1,
) =>
  `${lengthInputValue(width, precision)} × ${lengthInputValue(height, precision)} ${lengthUnit()}`;
