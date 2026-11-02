import {
  FOOT_METRES,
  getDisplayUnits,
  type DisplayUnits,
} from "../utils/units";

/** Pick a readable 1/2/5 distance; input and output widths are CSS pixels. */
export function scaleBar(
  pixelsPerMetre: number,
  maxWidth = 112,
  units: DisplayUnits = getDisplayUnits(),
) {
  if (
    !Number.isFinite(pixelsPerMetre) ||
    pixelsPerMetre <= 0 ||
    !Number.isFinite(maxWidth) ||
    maxWidth < 48
  )
    return null;
  const metresPerUnit = units === "metric" ? 1 : FOOT_METRES;
  const available = maxWidth / (pixelsPerMetre * metresPerUnit);
  const magnitude = 10 ** Math.floor(Math.log10(available));
  const length =
    (available / magnitude >= 5 ? 5 : available / magnitude >= 2 ? 2 : 1) *
    magnitude;
  return {
    width: length * metresPerUnit * pixelsPerMetre,
    label: `${length.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${units === "metric" ? "m" : "ft"}`,
  };
}
