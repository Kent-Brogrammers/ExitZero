import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BuildingScenario } from "../types/simulation";
import { formatLength } from "../utils/units";
import { useDisplayUnits } from "../utils/useDisplayUnits";
import { canvasPalette } from "../styles/canvasPalette";
import { canvasView, focusSelectionCamera, type Selection } from "./geometry";
import { elementBounds, selectionBounds } from "./selection";
import { drawLayout } from "./draw";
import type { FurnitureKind } from "./furniture";
import {
  arrangeActions,
  arrangeSelection,
  type ArrangeAction,
} from "./arrange";
import "./ArrangeDialog.css";

export interface ArrangeSource {
  building: BuildingScenario;
  selections: Selection[];
  furniture: ReadonlyMap<string, FurnitureKind>;
}

export function ArrangeDialog({
  source,
  stale,
  onApply,
  onClose,
}: {
  source: ArrangeSource;
  stale: boolean;
  onApply: (building: BuildingScenario) => boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const title = useId(),
    outside = useRef(false);
  const units = useDisplayUnits();
  const [action, setAction] = useState<ArrangeAction | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const result = useMemo(
    () =>
      action
        ? arrangeSelection(source.building, source.selections, action)
        : { building: source.building, changed: false, error: null },
    [source, action],
  );
  const error = stale
    ? "The layout changed. Cancel and reopen Arrange to use the current selection."
    : (result.error ?? applyError);
  const label = arrangeActions.find((option) => option.id === action)?.label;
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
      const bounds = selectionBounds(source.building, source.selections);
      if (!bounds || rect.width <= 0 || rect.height <= 0) return;
      const camera = focusSelectionCamera(
        rect.width,
        rect.height,
        source.building,
        bounds,
      );
      if (!camera) return;
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      const view = canvasView(
        Math.round(rect.width * ratio),
        Math.round(rect.height * ratio),
        source.building,
        camera,
        ratio,
      );
      const px = ratio / view.scale,
        palette = canvasPalette(target);
      drawLayout(
        target,
        result.building,
        source.selections,
        undefined,
        ratio,
        palette,
        {
          camera,
          furniture: source.furniture,
          showLabels: false,
          showDimensions: false,
          underlay: (ctx) => {
            ctx.save();
            ctx.strokeStyle = palette.muted;
            ctx.lineWidth = px;
            ctx.setLineDash([4 * px, 4 * px]);
            for (const item of source.selections) {
              const original = elementBounds(source.building, item)!;
              ctx.strokeRect(
                original.x,
                original.y,
                original.width,
                original.height,
              );
            }
            ctx.restore();
          },
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
  function options(distribute: boolean) {
    return arrangeActions
      .filter((option) => option.id.startsWith("gap-") === distribute)
      .map((option) => (
        <button
          key={option.id}
          type="button"
          className="studio-control"
          aria-label={option.label}
          aria-pressed={action === option.id}
          disabled={distribute && source.selections.length < 3}
          onClick={() => {
            setAction(option.id);
            setApplyError(null);
          }}
        >
          {option.short}
        </button>
      ));
  }
  return (
    <dialog
      ref={dialog}
      className="arrange-dialog"
      aria-labelledby={title}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        );
        const first = buttons[0],
          last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
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
      <header className="arrange-heading">
        <div>
          <h2 id={title}>Arrange selection</h2>
          <p>
            {source.selections.length} objects and zones · Preview before
            applying
          </p>
        </div>
        <button
          type="button"
          className="studio-control studio-control--icon"
          aria-label="Close Arrange"
          onClick={close}
        >
          ×
        </button>
      </header>
      <div className="arrange-content">
        <div className="arrange-choices">
          <fieldset>
            <legend>Align to selection bounds</legend>
            <div className="arrange-align-options">{options(false)}</div>
          </fieldset>
          <fieldset>
            <legend>Equal gaps</legend>
            <div className="arrange-gap-options">{options(true)}</div>
            <p>
              Three or more items. The first and last stay fixed; spacing is
              measured edge to edge.
            </p>
          </fieldset>
          <p>
            Positions change when you apply. Sizes, names, and occupant counts
            stay the same.
          </p>
        </div>
        <figure className="arrange-preview">
          <canvas
            ref={canvas}
            role="img"
            aria-label="Arrangement preview. Dashed outlines show original bounds; blue outlines show the selected result."
          />
          <figcaption>Dashed: original bounds · Blue: preview</figcaption>
        </figure>
      </div>
      <p className="arrange-feedback" role={error ? "alert" : "status"}>
        {error ??
          (!action
            ? "Choose an alignment or spacing option."
            : !result.changed
              ? "Already arranged this way."
              : `${label}${"gap" in result && result.gap !== undefined ? ` · ${formatLength(result.gap, 2)} gaps` : ""} · Apply to update the layout.`)}
      </p>
      <footer className="arrange-actions">
        <button type="button" className="studio-control" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="studio-control arrange-primary"
          disabled={!result.changed || !!error}
          onClick={() => {
            if (onApply(result.building)) close();
            else
              setApplyError(
                "Could not apply the arrangement. Cancel and reopen it to review the current layout.",
              );
          }}
        >
          Apply arrangement
        </button>
      </footer>
    </dialog>
  );
}
