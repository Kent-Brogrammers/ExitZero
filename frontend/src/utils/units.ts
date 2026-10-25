// Display conversion only. Building JSON, geometry and simulation remain in metres.
export const FOOT_METRES = 0.3048;
export const toFeet = (metres: number) => metres / FOOT_METRES;
export const toMetres = (feet: number) => feet * FOOT_METRES;
export const lengthInputValue = (metres: number, precision = 4) =>
  Number(toFeet(metres).toFixed(precision));

/** Blurring an untouched rounded field must preserve the exact stored geometry. */
export function lengthFromInput(feet: number, original: number, precision = 4) {
  return feet === lengthInputValue(original, precision)
    ? original
    : toMetres(feet);
}

export const formatLength = (metres: number, precision = 1) =>
  `${lengthInputValue(metres, precision)} ft`;
export const formatDimensions = (
  width: number,
  height: number,
  precision = 1,
) =>
  `${lengthInputValue(width, precision)} × ${lengthInputValue(height, precision)} ft`;
