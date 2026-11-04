import { useId, useState, type ComponentProps } from "react";
import "./NumberInput.css";

type NumberInputProps = Omit<
  ComponentProps<"input">,
  "value" | "defaultValue" | "type" | "step" | "min" | "max" | "onChange"
> & {
  value: number;
  onValue: (value: number) => void;
  /** Optional exact-unit handling for a relative step from a displayed value. */
  onStep?: (from: number, to: number) => void;
  min?: number;
  max?: number;
  /** Relative increment in the units shown, independent of the minimum. */
  step?: number;
  integer?: boolean;
  commitOnBlur?: boolean;
};

function decimalPlaces(value: number) {
  const [coefficient = "", exponent = "0"] = String(value).split("e");
  return Math.max(
    0,
    (coefficient.split(".")[1]?.length ?? 0) - Number(exponent),
  );
}

/** Keep partial text local; only valid numbers reach the model. */
export function NumberInput({
  value,
  onValue,
  onStep,
  min,
  max,
  step = 1,
  integer = false,
  commitOnBlur = false,
  id,
  className,
  disabled,
  onBlur,
  onKeyDown,
  ...props
}: NumberInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [draft, setDraft] = useState<string | null>(null);
  const valid = (n: number) =>
    Number.isFinite(n) &&
    (!integer || Number.isSafeInteger(n)) &&
    // An untouched rounded display can sit just beyond the exact converted bound.
    (n === value ||
      ((min === undefined || n >= min) && (max === undefined || n <= max)));
  const candidate = draft?.trim() ? Number(draft) : NaN;
  const base = valid(candidate) ? candidate : value;
  const label = props["aria-label"] ?? "value";
  function adjust(direction: number) {
    const precision = Math.min(
      15,
      Math.max(decimalPlaces(base), decimalPlaces(step)),
    );
    const next = Math.max(
      min ?? -Infinity,
      Math.min(
        max ?? Infinity,
        Number((base + direction * step).toFixed(precision)),
      ),
    );
    if (valid(next) && next !== value) {
      if (onStep) onStep(base, next);
      else onValue(next);
    }
    setDraft(null);
  }
  return (
    <span className="number-input">
      <input
        {...props}
        id={inputId}
        className={`number-input-field${className ? ` ${className}` : ""}`}
        type="number"
        // Typed decimals need not lie on the buttons' increment grid.
        step={integer ? 1 : "any"}
        min={min}
        max={max}
        disabled={disabled}
        value={draft ?? value}
        aria-invalid={
          draft !== null && draft !== "" && !valid(candidate) ? true : undefined
        }
        onChange={(event) => {
          const raw = event.currentTarget.value;
          setDraft(raw);
          const n = event.currentTarget.valueAsNumber;
          if (!commitOnBlur && valid(n) && n !== value) onValue(n);
        }}
        onBlur={(event) => {
          const n = event.currentTarget.valueAsNumber;
          if (commitOnBlur && valid(n) && n !== value) onValue(n);
          setDraft(null);
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            adjust(event.key === "ArrowUp" ? 1 : -1);
          } else if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <span className="number-input-steppers">
        <button
          type="button"
          className="number-input-step"
          aria-label={`Increase ${label}`}
          aria-controls={inputId}
          disabled={disabled || (max !== undefined && base >= max)}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => adjust(1)}
        />
        <button
          type="button"
          className="number-input-step"
          aria-label={`Decrease ${label}`}
          aria-controls={inputId}
          disabled={disabled || (min !== undefined && base <= min)}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => adjust(-1)}
        />
      </span>
    </span>
  );
}
