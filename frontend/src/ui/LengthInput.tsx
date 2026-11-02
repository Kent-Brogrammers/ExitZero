import type { ComponentProps } from "react";
import {
  lengthFromInput,
  lengthInputValue,
  toDisplayLength,
} from "../utils/units";
import { useDisplayUnits } from "../utils/useDisplayUnits";

/** Callers supply and receive metres; the visible field follows Settings. */
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
  useDisplayUnits();
  return (
    <input
      {...props}
      type="number"
      step="any"
      min={min === undefined ? undefined : toDisplayLength(min)}
      max={max === undefined ? undefined : toDisplayLength(max)}
      value={lengthInputValue(value, precision)}
      onChange={(event) => {
        const displayed = event.currentTarget.valueAsNumber;
        if (Number.isFinite(displayed))
          onValue(lengthFromInput(displayed, value, precision));
      }}
    />
  );
}
