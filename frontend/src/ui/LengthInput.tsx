import type { ComponentProps } from "react";
import { lengthFromInput, lengthInputValue, toFeet } from "../utils/units";

/** Callers supply and receive metres; only the visible field is in feet. */
export function LengthInput({
  value,
  onValue,
  min,
  max,
  precision = 4,
  ...props
}: Omit<
  ComponentProps<"input">,
  "value" | "defaultValue" | "type" | "min" | "max" | "onChange"
> & {
  value: number;
  onValue: (metres: number) => void;
  min?: number;
  max?: number;
  precision?: number;
}) {
  return (
    <input
      {...props}
      type="number"
      step="any"
      min={min === undefined ? undefined : toFeet(min)}
      max={max === undefined ? undefined : toFeet(max)}
      value={lengthInputValue(value, precision)}
      onChange={(event) => {
        const feet = event.currentTarget.valueAsNumber;
        if (Number.isFinite(feet))
          onValue(lengthFromInput(feet, value, precision));
      }}
    />
  );
}
