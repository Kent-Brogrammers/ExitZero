import { useEffect, useRef, useState, type PointerEvent } from "react";
import { ObjectNameField } from "./ObjectNameField";
import { objectName, nextObjectName, renameObject } from "./names";
import { EditorUtilityRail } from "./EditorUtilityRail";
import { EditorDrawingRail } from "./EditorDrawingRail";
import { addObject, addWallShape, dragRectangle } from "./shapes";
import { useStudioTheme } from "../styles/appearance";
import { isWallTool, type EditorTool } from "./tools";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario, Point } from "../types/simulation";
import {
  buildingError,
  canvasView,
  clamp,
  distance,
  openingSegment,
  project,
  removeElement,
  translateElement,
  wallLength,
  type Selection,
} from "./geometry";
import { drawLayout } from "./draw";
import "./BuildingEditor.css";

type Gesture = {
  start: Point;
  current: Point;
  base: BuildingScenario;
  selection?: Selection;
  endpoint?: "start" | "end";
};
interface BuildingEditorProps {
  building: BuildingScenario;
  onChange: (building: BuildingScenario) => void;
  disabled?: boolean;
}

function NumberField({
  label,
  value,
  onCommit,
  integer = false,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  integer?: boolean;
}) {
  return (
    <label className="number-field">
      {label}
      <input
        key={value}
        type="number"
        step={integer ? 1 : "any"}
        defaultValue={Number(value.toFixed(4))}
        onBlur={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (Number.isFinite(next) && next !== value) onCommit(next);
          event.currentTarget.value = String(Number(value.toFixed(4)));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

export function BuildingEditor({
  building,
  onChange,
  disabled = false,
}: BuildingEditorProps) {
  const theme = useStudioTheme();
  const canvas = useRef<HTMLCanvasElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const propertiesButton = useRef<HTMLButtonElement>(null);
  const [tool, setTool] = useState<EditorTool>("select");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<BuildingScenario[]>([]);
  const [redo, setRedo] = useState<BuildingScenario[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const selectedElement = selected
    ? building[selected.kind].find((v) => v.id === selected.id)
    : null;

  function closeProperties() {
    setPropertiesOpen(false);
    propertiesButton.current?.focus();
  }

  function selectElement(selection: Selection | null) {
    setSelected(selection);
    setPropertiesOpen(selection !== null);
  }

  function commit(next: BuildingScenario) {
    const problem = buildingError(next, false);
    if (problem) {
      setError(problem);
      return false;
    }
    setHistory((items) => [...items.slice(-49), structuredClone(building)]);
    setRedo([]);
    setError("");
    onChange(next);
    return true;
  }
  function changeTool(next: EditorTool) {
    setPropertiesOpen(false);
    setTool(next);
    setGesture(null);
    setError("");
    canvas.current?.focus({ preventScroll: true });
  }
  function world(event: PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    const view = canvasView(
      event.currentTarget.width,
      event.currentTarget.height,
      building,
    );
    return {
      x: clamp(
        (((event.clientX - rect.left) / rect.width) *
          event.currentTarget.width -
          view.x) /
          view.scale,
        0,
        building.width,
      ),
      y: clamp(
        (((event.clientY - rect.top) / rect.height) *
          event.currentTarget.height -
          view.y) /
          view.scale,
        0,
        building.height,
      ),
    };
  }
  function tolerance() {
    const target = canvas.current;
    if (!target) return 0.3;
    return (
      (12 * target.width) /
      target.getBoundingClientRect().width /
      canvasView(target.width, target.height, building).scale
    );
  }
  function snap(point: Point): Point {
    const endpoints = building.walls.flatMap((wall) => [wall.start, wall.end]);
    return endpoints.find((p) => distance(point, p) < tolerance()) ?? point;
  }
  function hit(point: Point): Selection | null {
    for (const kind of ["exits", "doors"] as const)
      for (const opening of building[kind]) {
        const wall = building.walls.find((w) => w.id === opening.wall_id)!;
        const [start, end] = openingSegment(opening, wall);
        if (project(point, { ...wall, start, end }).distance < tolerance())
          return { kind, id: opening.id };
      }
    const wall = building.walls.find(
      (w) =>
        project(point, w).distance < Math.max(tolerance(), w.thickness / 2),
    );
    if (wall) return { kind: "walls", id: wall.id };
    for (const kind of ["obstructions", "spawn_zones"] as const)
      for (const rectangle of building[kind]) {
        if (
          point.x >= rectangle.x &&
          point.x <= rectangle.x + rectangle.width &&
          point.y >= rectangle.y &&
          point.y <= rectangle.y + rectangle.height
        )
          return { kind, id: rectangle.id };
      }
    return null;
  }
  function moved(g: Gesture): BuildingScenario {
    if (!g.selection) return g.base;
    if (g.endpoint) {
      const next = structuredClone(g.base);
      next.walls.find((wall) => wall.id === g.selection!.id)![g.endpoint] =
        snap(g.current);
      return next;
    }
    return translateElement(g.base, g.selection, {
      x: g.current.x - g.start.x,
      y: g.current.y - g.start.y,
    });
  }
  const preview = gesture?.selection ? moved(gesture) : building;
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const redraw = () =>
      drawLayout(
        element,
        preview,
        selected,
        gesture && !gesture.selection
          ? {
              start: gesture.start,
              end: gesture.current,
              shape: tool,
            }
          : undefined,
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
  }, [preview, selected, gesture, tool, theme]);

  function pointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (disabled || event.button !== 0) return;
    event.currentTarget.focus({ preventScroll: true });
    const point = world(event);
    setError("");
    if (tool === "door" || tool === "exit") {
      const closest = building.walls
        .map((wall) => ({ wall, ...project(point, wall) }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (!closest || closest.distance > tolerance()) {
        setError("Click close to a wall to place an opening.");
        return;
      }
      const kind = tool === "door" ? "doors" : "exits";
      const width = Math.min(1.2, wallLength(closest.wall));
      const opening = {
        id: `${tool}_${crypto.randomUUID()}`,
        name: nextObjectName(building, kind),
        wall_id: closest.wall.id,
        offset: clamp(
          closest.offset - width / 2,
          0,
          wallLength(closest.wall) - width,
        ),
        width,
      };
      if (commit({ ...building, [kind]: [...building[kind], opening] })) {
        selectElement({ kind, id: opening.id });
        setTool("select");
      }
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "select") {
      let selection = hit(point);
      let endpoint: "start" | "end" | undefined;
      if (selected?.kind === "walls") {
        const wall = building.walls.find((w) => w.id === selected.id);
        if (wall) {
          if (distance(point, wall.start) < tolerance()) endpoint = "start";
          else if (distance(point, wall.end) < tolerance()) endpoint = "end";
          if (endpoint) selection = selected;
        }
      }
      selectElement(selection);
      if (selection)
        setGesture({
          start: point,
          current: point,
          base: building,
          selection,
          endpoint,
        });
    } else {
      const start = tool === "wall" ? snap(point) : point;
      selectElement(null);
      setGesture({ start, current: start, base: building });
    }
  }
  function pointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const point = world(event);
    setCursor(point);
    if (gesture)
      setGesture({
        ...gesture,
        current: tool === "wall" ? snap(point) : point,
      });
  }
  function pointerUp(event: PointerEvent<HTMLCanvasElement>) {
    if (!gesture) return;
    const g = {
      ...gesture,
      current: tool === "wall" ? snap(world(event)) : world(event),
    };
    setGesture(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (distance(g.start, g.current) < 0.02) return;
    if (g.selection) {
      commit(moved(g));
      return;
    }
    if (isWallTool(tool)) {
      const next = addWallShape(building, tool, g.start, g.current);
      if (commit(next))
        selectElement({
          kind: "walls",
          id: next.walls[building.walls.length]!.id,
        });
    } else if (tool === "spawn") {
      const rectangle = dragRectangle(g.start, g.current, building);
      const zone = {
        id: `spawn_${crypto.randomUUID()}`,
        name: nextObjectName(building, "spawn_zones"),
        ...rectangle,
        count: Math.min(
          10000,
          Math.max(1, Math.floor((rectangle.width * rectangle.height) / 1.5)),
        ),
      };
      if (commit({ ...building, spawn_zones: [...building.spawn_zones, zone] }))
        selectElement({ kind: "spawn_zones", id: zone.id });
    } else if (tool === "object-square" || tool === "object-rectangle") {
      const next = addObject(
        building,
        g.start,
        g.current,
        tool === "object-square",
      );
      if (commit(next))
        selectElement({
          kind: "obstructions",
          id: next.obstructions.at(-1)!.id,
        });
    }
  }
  function changeSelected(field: string, value: number) {
    if (!selected || !selectedElement) return;
    const next = structuredClone(building);
    const element = next[selected.kind].find((v) => v.id === selected.id)!;
    if ("start" in element && field.includes(".")) {
      const [endpoint, axis] = field.split(".") as ["start" | "end", "x" | "y"];
      element[endpoint][axis] = value;
    } else Object.assign(element, { [field]: value });
    commit(next);
  }
  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setRedo((items) => [...items, building]);
    setHistory((items) => items.slice(0, -1));
    setGesture(null);
    selectElement(null);
    setError("");
    onChange(previous);
  }
  function redoChange() {
    const next = redo.at(-1);
    if (!next) return;
    setHistory((items) => [...items, building]);
    setRedo((items) => items.slice(0, -1));
    setGesture(null);
    selectElement(null);
    setError("");
    onChange(next);
  }
  function exportLayout() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(building, null, 2) + "\n"], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "exitzero-layout.json";
    link.click();
    URL.revokeObjectURL(url);
  }
  async function importLayout(file?: File) {
    if (!file) return;
    try {
      if (file.size > 2_000_000 || !file.name.toLowerCase().endsWith(".json"))
        throw new Error("Choose a layout JSON file under 2 MB.");
      const value: unknown = JSON.parse(await file.text());
      const problem = buildingError(value, false);
      if (problem) throw new Error(problem);
      if (commit(value as BuildingScenario)) {
        selectElement(null);
        setGesture(null);
      }
    } catch (reason) {
      setError(
        reason instanceof SyntaxError
          ? "The selected file is not valid JSON."
          : reason instanceof Error
            ? reason.message
            : "Could not import layout.",
      );
    }
    if (importInput.current) importInput.current.value = "";
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
          <h2 id="building-title">Build your floor plan</h2>
        </div>
        <span className="badge">Freeform · metres</span>
      </div>
      <fieldset className="editor-controls" disabled={disabled}>
        <div className="editor-workspace">
          <div className="editor-commandbar">
            <EditorDrawingRail
              tool={tool}
              disabled={disabled}
              onTool={changeTool}
              onOpenPanel={() => setPropertiesOpen(false)}
            />
            <EditorUtilityRail
              disabled={disabled}
              canUndo={history.length > 0}
              canRedo={redo.length > 0}
              propertiesOpen={propertiesOpen}
              propertiesButton={propertiesButton}
              onUndo={undo}
              onRedo={redoChange}
              onNew={() => {
                if (
                  commit({
                    ...building,
                    walls: [],
                    doors: [],
                    exits: [],
                    spawn_zones: [],
                    blocked_exit_ids: [],
                    obstructions: [],
                  })
                ) {
                  selectElement(null);
                  setGesture(null);
                }
              }}
              onExample={() => {
                if (commit(structuredClone(example))) {
                  selectElement(null);
                  setGesture(null);
                }
              }}
              onImport={() => importInput.current?.click()}
              onExport={exportLayout}
              onProperties={() => setPropertiesOpen(!propertiesOpen)}
            />
            <input
              ref={importInput}
              hidden
              type="file"
              accept=".json,application/json"
              aria-label="Import layout JSON"
              onChange={(event) => void importLayout(event.target.files?.[0])}
            />
          </div>
          <div className="editor-stage">
            {selectedElement && selected && (
              <p
                className="editor-selection-feedback"
                role="status"
                title={objectName(building, selected)}
              >
                Selected: {objectName(building, selected)}
              </p>
            )}
            <p className="editor-help">
              {tool === "select"
                ? "Drag objects or wall endpoints. Select an object to edit its name and properties."
                : tool === "wall"
                  ? "Drag a straight wall at any angle. Nearby endpoints snap together."
                  : tool === "wall-rectangle"
                    ? "Drag opposite corners to draw four connected walls. Each segment remains individually editable."
                    : tool === "wall-circle"
                      ? "Drag from the centre to set the radius. Saves 24 straight wall segments, not a true curve."
                      : tool === "door" || tool === "exit"
                        ? `Click a wall to place ${tool === "exit" ? "an exit" : "a door"}. Adjust its width in Properties.`
                        : tool === "spawn"
                          ? "Drag a spawn area, then set its name and occupant count in Properties."
                          : `Drag to draw ${tool === "object-square" ? "a square" : "a rectangle"} physical obstacle. Name and resize it in Properties.`}
            </p>
            <div className="canvas-wrap editor-canvas-wrap">
              <canvas
                ref={canvas}
                width={1200}
                height={800}
                tabIndex={0}
                role="img"
                aria-label={`Editable floor plan, ${building.width} by ${building.height} metres. ${building.walls.length} walls, ${building.doors.length} doors, ${building.exits.length} exits, ${building.spawn_zones.length} spawn zones, ${building.obstructions.length} obstructions. ${selectedElement && selected ? `Selected: ${objectName(building, selected)}. ` : ""}Use layout tools to draw or the element inspector to edit.`}
                style={{
                  aspectRatio: "3 / 2",
                  cursor:
                    tool === "select"
                      ? gesture
                        ? "grabbing"
                        : "default"
                      : "crosshair",
                }}
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={() => setGesture(null)}
                onLostPointerCapture={() => setGesture(null)}
                onPointerLeave={() => setCursor(null)}
                onKeyDown={(event) => {
                  if (disabled) return;
                  if (event.key === "Escape") {
                    setGesture(null);
                    selectElement(null);
                  }
                  if (
                    (event.key === "Delete" || event.key === "Backspace") &&
                    selected
                  ) {
                    event.preventDefault();
                    if (commit(removeElement(building, selected)))
                      selectElement(null);
                  }
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key.toLowerCase() === "z"
                  ) {
                    event.preventDefault();
                    if (event.shiftKey) redoChange();
                    else undo();
                  }
                }}
              />
              <div className="canvas-caption">
                <span>
                  {building.walls.length} walls · {building.doors.length} doors
                  · {building.exits.length} exits ·{" "}
                  {building.spawn_zones.length} spawn zones
                </span>
                <span>
                  {cursor
                    ? `${cursor.x.toFixed(2)}, ${cursor.y.toFixed(2)} m`
                    : "Continuous coordinates"}
                </span>
              </div>
            </div>
          </div>
          <aside
            className="editor-inspector"
            id="editor-properties"
            aria-label="Element inspector"
            hidden={!propertiesOpen}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeProperties();
            }}
          >
            <div className="inspector-heading">
              <h3>Properties</h3>
              <button
                type="button"
                aria-label="Close properties"
                onClick={closeProperties}
              >
                ×
              </button>
            </div>
            <label className="element-select">
              Selected element
              <select
                aria-label="Selected element"
                value={selected ? `${selected.kind}:${selected.id}` : ""}
                onChange={(event) => {
                  const [kind, ...parts] = event.target.value.split(":");
                  const id = parts.join(":");
                  selectElement(
                    id ? { kind: kind as Selection["kind"], id } : null,
                  );
                  setTool("select");
                  setGesture(null);
                }}
              >
                <option value="">None</option>
                {(
                  [
                    "walls",
                    "doors",
                    "exits",
                    "spawn_zones",
                    "obstructions",
                  ] as const
                ).flatMap((kind) =>
                  building[kind].map((v) => (
                    <option key={v.id} value={`${kind}:${v.id}`}>
                      {objectName(building, { kind, id: v.id })} ·{" "}
                      {v.id.slice(0, 16)}
                    </option>
                  )),
                )}
              </select>
            </label>
            {selectedElement && selected ? (
              <div className="inspector-fields">
                <ObjectNameField
                  key={`${selected.kind}:${selected.id}:${objectName(building, selected)}`}
                  name={objectName(building, selected)}
                  onCommit={(name) =>
                    commit(renameObject(building, selected, name))
                  }
                />
                {selected.kind === "obstructions" && (
                  <p className="note">
                    Rectangular physical obstacle. Names and dimensions are
                    saved; width and height can be resized independently.
                  </p>
                )}
                <p className="note">
                  {"wall_id" in selectedElement
                    ? `Attached to ${selectedElement.wall_id}`
                    : "Dimensions in metres"}
                </p>
                {"start" in selectedElement ? (
                  <>
                    {(["start", "end"] as const).flatMap((end) =>
                      (["x", "y"] as const).map((axis) => (
                        <NumberField
                          key={`${end}.${axis}`}
                          label={`${end} ${axis}`}
                          value={selectedElement[end][axis]}
                          onCommit={(value) =>
                            changeSelected(`${end}.${axis}`, value)
                          }
                        />
                      )),
                    )}
                    <NumberField
                      label="Thickness"
                      value={selectedElement.thickness}
                      onCommit={(value) => changeSelected("thickness", value)}
                    />
                  </>
                ) : (
                  <>
                    {(["x", "y", "width", "height", "offset", "count"] as const)
                      .filter((field) => field in selectedElement)
                      .map((field) => (
                        <NumberField
                          key={field}
                          label={field === "count" ? "Occupants" : field}
                          value={
                            (
                              selectedElement as unknown as Record<
                                string,
                                number
                              >
                            )[field]!
                          }
                          integer={field === "count"}
                          onCommit={(value) => changeSelected(field, value)}
                        />
                      ))}
                  </>
                )}
                {selected.kind === "exits" && (
                  <label className="block-toggle">
                    <input
                      type="checkbox"
                      checked={building.blocked_exit_ids.includes(selected.id)}
                      onChange={(event) =>
                        commit({
                          ...building,
                          blocked_exit_ids: event.target.checked
                            ? [...building.blocked_exit_ids, selected.id]
                            : building.blocked_exit_ids.filter(
                                (id) => id !== selected.id,
                              ),
                        })
                      }
                    />
                    Block this exit
                  </label>
                )}
                <button
                  className="delete-button"
                  onClick={() => {
                    if (commit(removeElement(building, selected)))
                      selectElement(null);
                  }}
                >
                  Delete selected
                </button>
              </div>
            ) : (
              <p className="note">
                Select an element on the canvas or from this list. Changes are
                local until you export the layout.
              </p>
            )}
            <details className="workspace-settings">
              <summary>Canvas size</summary>
              <NumberField
                label="Width (m)"
                value={building.width}
                onCommit={(width) => commit({ ...building, width })}
              />
              <NumberField
                label="Height (m)"
                value={building.height}
                onCommit={(height) => commit({ ...building, height })}
              />
            </details>
          </aside>
        </div>
      </fieldset>
      {error && (
        <p className="editor-error" role="alert">
          {error}
        </p>
      )}
      <div className="legend">
        <span>
          <i className="swatch wall" />
          Wall
        </span>
        <span>
          <i className="swatch door" />
          Door opening
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
      <p className="note">
        Layouts use continuous metre coordinates. Save your work with Export
        JSON; simulation and playback remain separate workstreams.
      </p>
    </section>
  );
}
