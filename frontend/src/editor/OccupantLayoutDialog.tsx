import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BuildingScenario } from "../types/simulation";
import { LengthInput } from "../ui/LengthInput";
import { lengthUnit } from "../utils/units";
import { useDisplayUnits } from "../utils/useDisplayUnits";
import { totalPopulation } from "../utils/population";
import { canvasPalette } from "../styles/canvasPalette";
import { drawLayout } from "./draw";
import { focusSelectionCamera } from "./geometry";
import { selectionBounds } from "./selection";
import { objectName } from "./names";
import type { FurnitureKind } from "./furniture";
import {
  occupantsAroundObject,
  type OccupantLayoutResult,
  type OccupantLayoutSides,
} from "./occupantLayout";
import "./OccupantLayoutDialog.css";

export interface OccupantLayoutSource {
  building: BuildingScenario;
  objectId: string;
  furniture: ReadonlyMap<string, FurnitureKind>;
}

export function OccupantLayoutDialog({
  source,
  stale,
  onApply,
  onClose,
}: {
  source: OccupantLayoutSource;
  stale: boolean;
  onApply: (result: OccupantLayoutResult) => boolean;
  onClose: () => void;
}) {
  const title = useId(),
    help = useId(),
    feedback = useId();
  const dialog = useRef<HTMLDialogElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    outside = useRef(false);
  const [count, setCount] = useState("6");
  const [sides, setSides] = useState<OccupantLayoutSides>("all");
  const [clearance, setClearance] = useState(0.15);
  const [applyError, setApplyError] = useState("");
  const units = useDisplayUnits();
  const result = useMemo(
    () =>
      occupantsAroundObject(source.building, source.objectId, {
        count: Number(count),
        sides,
        clearance,
      }),
    [source, count, sides, clearance],
  );
  const error = stale
    ? "The layout changed. Cancel and reopen this preview to use the current object."
    : result.error || applyError;
  const object = { kind: "obstructions" as const, id: source.objectId };
  const name = objectName(source.building, object);
  useEffect(() => {
    const target = dialog.current;
    target?.showModal();
    return () => target?.close();
  }, []);
  function close() {
    dialog.current?.close();
    onClose();
  }
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const redraw = () => {
      const rect = target.getBoundingClientRect();
      const bounds = selectionBounds(
        result.building,
        [{ kind: "obstructions", id: source.objectId }, ...result.selections],
        true,
      );
      if (!bounds || rect.width <= 0 || rect.height <= 0) return;
      // Leave some surrounding floor visible so nearby walls and objects explain skipped spots.
      const camera = focusSelectionCamera(
        rect.width,
        rect.height,
        source.building,
        {
          x: bounds.x - 0.6,
          y: bounds.y - 0.6,
          width: bounds.width + 1.2,
          height: bounds.height + 1.2,
        },
      );
      if (!camera) return;
      drawLayout(
        target,
        result.building,
        result.selections,
        undefined,
        Math.max(1, window.devicePixelRatio || 1),
        canvasPalette(target),
        {
          camera,
          furniture: source.furniture,
          showLabels: false,
          showDimensions: false,
        },
      );
    };
    const observer = new ResizeObserver(redraw);
    observer.observe(target);
    window.addEventListener("resize", redraw);
    redraw();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", redraw);
    };
  }, [source, result, units]);
  return (
    <dialog
      ref={dialog}
      className="occupant-layout-dialog"
      aria-labelledby={title}
      aria-describedby={help}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = event.currentTarget.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
        );
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
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
      <header className="occupant-layout-heading">
        <div>
          <h2 id={title}>People around object</h2>
          <p>{name}</p>
        </div>
        <button
          type="button"
          className="studio-control studio-control--icon"
          aria-label="Close occupant layout"
          onClick={close}
        >
          ×
        </button>
      </header>
      <div className="occupant-layout-content">
        <div className="occupant-layout-options">
          <label>
            People to add
            <input
              autoFocus
              type="number"
              min={1}
              max={100}
              step={1}
              value={count}
              aria-describedby={feedback}
              onChange={(event) => {
                setCount(event.target.value);
                setApplyError("");
              }}
            />
          </label>
          <label>
            Sides
            <select
              aria-label="Sides"
              value={sides}
              onChange={(event) => {
                setSides(event.target.value as OccupantLayoutSides);
                setApplyError("");
              }}
            >
              <option value="all">All sides</option>
              <option value="horizontal">Top and bottom</option>
              <option value="vertical">Left and right</option>
            </select>
          </label>
          <label>
            Body clearance ({lengthUnit()})
            <LengthInput
              value={clearance}
              onValue={(value) => {
                setClearance(value);
                setApplyError("");
              }}
              min={0}
              max={2}
            />
          </label>
          <p id={help}>
            Preview clear starting positions around rectangular furniture.
            Walls, objects, existing people and workspace edges are respected.
          </p>
          <p>
            People save as individual starting positions. Existing spawn areas
            keep their counts.
          </p>
        </div>
        <figure className="occupant-layout-preview">
          <canvas
            ref={canvas}
            role="img"
            aria-label={`Occupant placement preview, ${result.selections.length} new starting positions around ${name}`}
          />
          <figcaption>
            Blue outlines: new people · Apply adds them to the layout
          </figcaption>
        </figure>
      </div>
      <p
        id={feedback}
        className="occupant-layout-feedback"
        role={error ? "alert" : "status"}
      >
        {error ||
          `${result.selections.length} people ready · Population ${totalPopulation(source.building)} → ${totalPopulation(result.building)}`}
      </p>
      <footer className="occupant-layout-actions">
        <button type="button" className="studio-control" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="studio-control occupant-layout-primary"
          disabled={!!error || !result.selections.length}
          onClick={() => {
            if (onApply(result)) close();
            else
              setApplyError(
                "Could not apply these positions. Cancel and reopen the preview.",
              );
          }}
        >
          Add people
        </button>
      </footer>
    </dialog>
  );
}
