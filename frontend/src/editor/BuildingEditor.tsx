import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario, Cell } from "../types/simulation";
import { drawBuilding } from "./canvas";
import {
  applyCellTool,
  cellsAlongStroke,
  pointerToCell,
  resizeBuilding,
} from "./editing";
import type { EditorTool } from "./editing";
import "./BuildingEditor.css";

interface BuildingEditorProps {
  building: BuildingScenario;
  onChange: (building: BuildingScenario) => void;
  disabled?: boolean;
}

const tools: { id: EditorTool; label: string }[] = [
  { id: "wall", label: "Wall" },
  { id: "walkable", label: "Walkable" },
  { id: "door", label: "Door" },
  { id: "exit", label: "Exit" },
  { id: "erase", label: "Erase" },
];

export function BuildingEditor({
  building,
  onChange,
  disabled = false,
}: BuildingEditorProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const currentBuilding = useRef(building);
  const stroke = useRef<{
    pointerId: number;
    lastCell: Cell | null;
    tool: EditorTool;
  } | null>(null);
  const [tool, setTool] = useState<EditorTool>("wall");
  const [selected, setSelected] = useState<Cell>({ x: 0, y: 0 });
  const [notice, setNotice] = useState({
    text: "Choose a tool and edit the floor plan.",
    error: false,
  });
  // A resize can move the keyboard cursor out of bounds; keep it on the grid.
  const cursor = {
    x: Math.min(selected.x, building.width - 1),
    y: Math.min(selected.y, building.height - 1),
  };

  useEffect(() => {
    currentBuilding.current = building;
  }, [building]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const redraw = () =>
      drawBuilding(
        element,
        building,
        { x: cursor.x, y: cursor.y },
        window.devicePixelRatio,
      );
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(element);
    window.addEventListener("resize", redraw);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", redraw);
    };
  }, [building, cursor.x, cursor.y]);

  function updateBuilding(next: BuildingScenario) {
    currentBuilding.current = next;
    onChange(next);
  }

  function edit(cells: Cell[], activeTool: EditorTool) {
    if (disabled) return;
    const previous = currentBuilding.current;
    let next = previous;
    let error: string | null = null;
    for (const cell of cells) {
      const result = applyCellTool(next, cell, activeTool);
      next = result.building;
      error ??= result.error;
    }
    if (next !== previous) updateBuilding(next);
    setNotice({
      text:
        error ??
        "Layout updated. Changes are held in this session; save JSON to keep a copy.",
      error: error !== null,
    });
  }

  function eventCell(event: PointerEvent<HTMLCanvasElement>) {
    return pointerToCell(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
      currentBuilding.current,
    );
  }

  function startStroke(event: PointerEvent<HTMLCanvasElement>) {
    if (disabled || event.button !== 0 || !event.isPrimary) return;
    const cell = eventCell(event);
    if (!cell) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    stroke.current = { pointerId: event.pointerId, lastCell: cell, tool };
    setSelected(cell);
    edit([cell], tool);
  }

  function continueStroke(event: PointerEvent<HTMLCanvasElement>) {
    const active = stroke.current;
    if (!active || active.pointerId !== event.pointerId || disabled) return;
    const cell = eventCell(event);
    const previous = active.lastCell;
    active.lastCell = cell;
    if (!cell) return;
    setSelected(cell);
    if (
      active.tool !== "wall" &&
      active.tool !== "walkable" &&
      active.tool !== "erase"
    )
      return;
    if (previous && previous.x === cell.x && previous.y === cell.y) return;
    edit(previous ? cellsAlongStroke(previous, cell) : [cell], active.tool);
  }

  function finishStroke(event: PointerEvent<HTMLCanvasElement>) {
    if (stroke.current?.pointerId !== event.pointerId) return;
    stroke.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function editWithKeyboard(event: KeyboardEvent<HTMLCanvasElement>) {
    if (disabled) return;
    const moves: Record<string, Cell> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      setSelected({
        x: Math.max(0, Math.min(building.width - 1, cursor.x + move.x)),
        y: Math.max(0, Math.min(building.height - 1, cursor.y + move.y)),
      });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      edit([cursor], tool);
    }
  }

  function saveJson() {
    const blob = new Blob(
      [JSON.stringify(currentBuilding.current, null, 2) + "\n"],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "exitzero-building.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice({ text: "Building JSON downloaded.", error: false });
  }

  return (
    <section
      className="panel editor-panel"
      id="building"
      aria-labelledby="building-title"
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">01 / Building</p>
          <h2 id="building-title">Floor plan</h2>
        </div>
        <span className="badge">
          {building.width} × {building.height} · {building.exits.length} exits
        </span>
      </div>
      <div className="editor-tools" role="group" aria-label="Editing tools">
        {tools.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={tool === id}
            disabled={disabled}
            onClick={() => setTool(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="note" id="editor-instructions">
        Click to edit. Drag with Wall, Walkable or Erase. Exits belong on the
        boundary. Keyboard: use arrow keys to select a cell, then Enter or Space
        to apply the tool.
      </p>
      <p className="editor-selection">
        Active tool:{" "}
        <strong>{tools.find(({ id }) => id === tool)?.label}</strong> · Selected
        cell ({cursor.x}, {cursor.y})
      </p>
      <div className="canvas-wrap editor-canvas-wrap">
        <canvas
          ref={canvas}
          width={building.width * 24}
          height={building.height * 24}
          style={{
            aspectRatio: `${building.width} / ${building.height}`,
            maxWidth: `${Math.min(building.width * 24, (2048 * building.width) / building.height)}px`,
            touchAction: "none",
          }}
          role="application"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          aria-label={`Floor-plan editor, ${building.width} by ${building.height} cells. ${tool} tool. Selected cell ${cursor.x}, ${cursor.y}.`}
          aria-describedby="editor-instructions editor-feedback"
          onPointerDown={startStroke}
          onPointerMove={continueStroke}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onLostPointerCapture={finishStroke}
          onKeyDown={editWithKeyboard}
        />
      </div>
      <p
        id="editor-feedback"
        className={`editor-feedback${notice.error ? " editor-error" : ""}`}
        role="status"
      >
        {notice.text}
      </p>
      <div className="legend" aria-label="Floor plan legend">
        <span>
          <i className="swatch wall" />
          Wall
        </span>
        <span>
          <i className="swatch door" />
          Door
        </span>
        <span>
          <i className="swatch exit" />
          Exit
        </span>
        <span>
          <i className="swatch spawn" />
          Spawn zone
        </span>
      </div>
      <form
        key={`${building.width}-${building.height}`}
        className="editor-dimensions"
        aria-label="Building dimensions"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          const data = new FormData(event.currentTarget);
          const result = resizeBuilding(
            currentBuilding.current,
            Number(data.get("width")),
            Number(data.get("height")),
          );
          if (!result.error) updateBuilding(result.building);
          setNotice({
            text: result.error ?? "Building dimensions updated.",
            error: result.error !== null,
          });
        }}
      >
        <label>
          Width
          <input
            name="width"
            type="number"
            min="1"
            max="512"
            step="1"
            required
            defaultValue={building.width}
            disabled={disabled}
          />
        </label>
        <label>
          Height
          <input
            name="height"
            type="number"
            min="1"
            max="512"
            step="1"
            required
            defaultValue={building.height}
            disabled={disabled}
          />
        </label>
        <button type="submit" disabled={disabled}>
          Resize grid
        </button>
      </form>
      <div className="editor-actions">
        <button type="button" disabled={disabled} onClick={saveJson}>
          Save JSON
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            updateBuilding(structuredClone(example));
            setSelected({ x: 0, y: 0 });
            setNotice({
              text: "Example building loaded. Previous session edits were replaced.",
              error: false,
            });
          }}
        >
          Load example
        </button>
      </div>
      <p className="note">
        <strong>
          {building.spawn_zones.reduce((total, zone) => total + zone.count, 0)}{" "}
          occupants
        </strong>{" "}
        · Spawn rectangles and counts are preserved in this version.
      </p>
      <ul className="editor-spawns">
        {building.spawn_zones.map((zone) => (
          <li key={`${zone.x}-${zone.y}`}>
            Zone at ({zone.x}, {zone.y}) · {zone.width} × {zone.height} cells ·{" "}
            {zone.count} occupants
          </li>
        ))}
      </ul>
      <p className="note">
        Origin: top left. x increases right; y increases down. Each grid cell is
        one logical unit.
      </p>
    </section>
  );
}
