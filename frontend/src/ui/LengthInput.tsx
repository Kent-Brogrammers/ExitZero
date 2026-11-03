import type { ComponentProps } from "react";
import {
  lengthFromInput,
  lengthInputValue,
  toDisplayLength,
  toMetres,
} from "../utils/units";
import { useDisplayUnits } from "../utils/useDisplayUnits";
import { NumberInput } from "./NumberInput";

/** Callers supply and receive metres; the visible field follows Settings. */
export function LengthInput({
  value,
  onValue,
  min,
  max,
  step = 1,
  precision = 4,
  ...props
}: Omit<
  ComponentProps<"input">,
  "value" | "defaultValue" | "type" | "min" | "max" | "onChange" | "step"
> & {
  value: number;
  onValue: (metres: number) => void;
  min?: number;
  max?: number;
  precision?: number;
  commitOnBlur?: boolean;
  /** Increment in the displayed length unit, not metres. */
  step?: number;
}) {
  const units = useDisplayUnits();
  return (
    <NumberInput
      {...props}
      key={units}
      step={step}
      min={min === undefined ? undefined : toDisplayLength(min)}
      max={max === undefined ? undefined : toDisplayLength(max)}
      value={lengthInputValue(value, precision)}
      onValue={(displayed) =>
        onValue(lengthFromInput(displayed, value, precision))
      }
      onStep={(from, to) => {
        const delta = units === "metric" ? to - from : toMetres(to - from);
        const next = lengthFromInput(from, value, precision) + delta;
        onValue(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, next)));
      }}
    />
  );
}
