import { useEffect, useId, useRef, useState } from "react";
import { LengthInput } from "../ui/LengthInput";
import { formatDimensions, lengthUnit } from "../utils/units";
import { useDisplayUnits } from "../utils/useDisplayUnits";
import {
  tracingBounds,
  tracingConfigError,
  type TracingReference,
} from "./tracing";
import "./TracingImageDialog.css";

export function TracingImageDialog({
  source,
  disabled,
  onApply,
  onClose,
}: {
  source: TracingReference;
  disabled: boolean;
  onApply: (reference: TracingReference) => void;
  onClose: () => void;
}) {
  useDisplayUnits();
  const title = useId(),
    errorId = useId();
  const dialog = useRef<HTMLDialogElement>(null),
    outside = useRef(false);
  const [config, setConfig] = useState(source.config);
  const error = tracingConfigError(source.asset, config);
  const bounds = error ? null : tracingBounds(source.asset, config);
  useEffect(() => {
    const target = dialog.current;
    target?.showModal();
    return () => target?.close();
  }, []);
  function close() {
    dialog.current?.close();
    onClose();
  }
  return (
    <dialog
      ref={dialog}
      className="tracing-dialog"
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        outside.current =
          event.target === event.currentTarget &&
          (event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom);
      }}
      onClick={(event) => {
        if (outside.current && event.target === event.currentTarget) close();
        outside.current = false;
      }}
    >
      <header className="tracing-heading">
        <div>
          <h2 id={title}>Tracing image</h2>
          <p>{source.asset.name}</p>
        </div>
        <button
          type="button"
          className="studio-control studio-control--icon"
          aria-label="Close tracing image"
          onClick={close}
        >
          ×
        </button>
      </header>
      <div className="tracing-dialog-content">
        <div className="tracing-preview">
          <img
            src={source.asset.url}
            alt="Your floor-plan background"
            style={{ opacity: config.opacity }}
          />
        </div>
        <div className="tracing-options">
          <label>
            Image opacity · {Math.round(config.opacity * 100)}%
            <input
              type="range"
              min={5}
              max={80}
              step={5}
              value={Math.round(config.opacity * 100)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  opacity: event.currentTarget.valueAsNumber / 100,
                })
              }
            />
          </label>
          <div>
            <label>
              Image width ({lengthUnit()})
              <LengthInput
                value={config.width}
                onValue={(width) =>
                  setConfig({ ...config, width, sizing: "custom" })
                }
                min={0}
                max={1000}
                aria-describedby={errorId}
              />
            </label>
            <p className="tracing-size-help">
              Height follows the image's proportions.
            </p>
          </div>
          {bounds && (
            <p>
              {formatDimensions(bounds.width, bounds.height, 2)} ·{" "}
              {config.sizing === "fitted"
                ? "Fitted size, not measured"
                : "Your entered size"}
            </p>
          )}
          <details>
            <summary>Position on the plan</summary>
            <div className="tracing-position-fields">
              {(["x", "y"] as const).map((axis) => (
                <label key={axis}>
                  Image {axis.toUpperCase()} ({lengthUnit()})
                  <LengthInput
                    value={config[axis]}
                    onValue={(value) => setConfig({ ...config, [axis]: value })}
                    min={0}
                    max={1000}
                  />
                </label>
              ))}
            </div>
          </details>
        </div>
      </div>
      <p>
        Draw over the image using Walls, Openings, People, and Objects. Only
        those drawn elements are used in simulations.
      </p>
      <p
        className="tracing-feedback"
        id={errorId}
        role={error || disabled ? "status" : undefined}
      >
        {disabled
          ? "Finish the current simulation before changing the image."
          : error ||
            "Set the image's real width if you need accurate measurements."}
      </p>
      <footer className="tracing-actions">
        <p>Image settings are remembered in this browser.</p>
        <button type="button" className="studio-control" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="studio-control tracing-primary"
          disabled={disabled || !!error}
          onClick={() => {
            onApply({ asset: source.asset, config });
            close();
          }}
        >
          Apply changes
        </button>
      </footer>
    </dialog>
  );
}
