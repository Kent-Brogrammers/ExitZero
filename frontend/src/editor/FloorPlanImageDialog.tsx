import { useEffect, useId, useRef, useState } from "react";
import type { BuildingScenario } from "../types/simulation";
import type { CanvasPalette } from "../styles/canvasPalette";
import type { DraftingPreferences } from "./drafting";
import type { FurnitureKind } from "./furniture";
import {
  createFloorPlanImage,
  downloadFloorPlanImage,
  floorPlanImageSize,
} from "./floorPlanImage";
import "./FloorPlanImageDialog.css";

export interface FloorPlanImageSource {
  building: BuildingScenario;
  drafting: DraftingPreferences;
  furniture: ReadonlyMap<string, FurnitureKind>;
  palette: CanvasPalette;
}

export function FloorPlanImageDialog({
  source,
  onClose,
}: {
  source: FloorPlanImageSource;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const pending = useRef(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [options, setOptions] = useState({
    includeGrid: source.drafting.visible,
    includeMeasurements: true,
  });
  const size = floorPlanImageSize(source.building);
  useEffect(() => {
    const target = dialog.current,
      previous = document.activeElement;
    target?.showModal();
    return () => {
      pending.current = false;
      target?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  function close() {
    pending.current = false;
    onClose();
  }
  async function start() {
    if (pending.current) return;
    pending.current = true;
    setRunning(true);
    setError("");
    try {
      const blob = await createFloorPlanImage(
        source.building,
        options,
        source.drafting,
        source.furniture,
        source.palette,
      );
      if (!pending.current) return;
      downloadFloorPlanImage(blob);
      close();
    } catch (reason) {
      if (pending.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not export the floor plan.",
        );
    } finally {
      if (pending.current) {
        pending.current = false;
        setRunning(false);
      }
    }
  }
  return (
    <dialog
      ref={dialog}
      className="floor-plan-image-dialog"
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <div className="floor-plan-image-heading">
          <h2 id={title}>Export Image</h2>
          <button
            type="button"
            className="studio-control studio-control--icon"
            aria-label="Close image export"
            onClick={close}
          >
            ×
          </button>
        </div>
        <p>
          PNG · {size.width.toLocaleString()} × {size.height.toLocaleString()}{" "}
          pixels · Entire drawing
        </p>
        <fieldset disabled={running}>
          <label>
            <input
              type="checkbox"
              checked={options.includeGrid}
              onChange={(event) =>
                setOptions({ ...options, includeGrid: event.target.checked })
              }
            />
            Include grid
          </label>
          <label>
            <input
              type="checkbox"
              checked={options.includeMeasurements}
              onChange={(event) =>
                setOptions({
                  ...options,
                  includeMeasurements: event.target.checked,
                })
              }
            />
            Include measurements
          </label>
        </fieldset>
        <p>
          Uses the grid spacing and measurement types from View. Selection
          handles and interface controls are excluded.
        </p>
        <p>Keep an editable copy with Save or Export JSON.</p>
        {error && <p role="alert">{error}</p>}
        <div className="floor-plan-image-actions">
          <button type="button" className="studio-control" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="studio-control floor-plan-image-primary"
            disabled={running}
          >
            {running ? "Exporting…" : "Download PNG"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
