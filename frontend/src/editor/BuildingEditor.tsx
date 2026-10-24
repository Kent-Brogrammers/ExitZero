import { useEffect, useRef, useState, type PointerEvent } from "react";
import { StudioPopover } from "../ui/StudioPopover";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario, Point, Wall } from "../types/simulation";
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
import { ToolIcon } from "./ToolIcon";
import "./BuildingEditor.css";

type Tool = "select" | "wall" | "door" | "exit" | "spawn" | "obstruction";
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
  const canvas = useRef<HTMLCanvasElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const propertiesButton = useRef<HTMLButtonElement>(null);
  const [tool, setTool] = useState<Tool>("select");
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
  function changeTool(next: Tool) {
    setPropertiesOpen(false);
    setTool(next);
    setGesture(null);
    setError("");
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
              rectangle: tool !== "wall",
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
  }, [preview, selected, gesture, tool]);

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
    const id = `${tool}_${crypto.randomUUID()}`;
    if (tool === "wall") {
      const wall: Wall = { id, start: g.start, end: g.current, thickness: 0.2 };
      if (commit({ ...building, walls: [...building.walls, wall] }))
        selectElement({ kind: "walls", id });
    } else {
      const rectangle = {
        id,
        x: Math.min(g.start.x, g.current.x),
        y: Math.min(g.start.y, g.current.y),
        width: Math.abs(g.start.x - g.current.x),
        height: Math.abs(g.start.y - g.current.y),
      };
      if (tool === "spawn") {
        const zone = {
          ...rectangle,
          count: Math.min(
            10000,
            Math.max(1, Math.floor((rectangle.width * rectangle.height) / 1.5)),
          ),
        };
        if (
          commit({ ...building, spawn_zones: [...building.spawn_zones, zone] })
        )
          selectElement({ kind: "spawn_zones", id });
      } else if (
        commit({
          ...building,
          obstructions: [...building.obstructions, rectangle],
        })
      )
        selectElement({ kind: "obstructions", id });
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
            <div
              className="editor-toolbar"
              role="toolbar"
              aria-label="Layout tools"
            >
              {(
                [
                  ["select", "Select / move"],
                  ["wall", "Wall"],
                  ["door", "Door"],
                  ["exit", "Exit"],
                  ["spawn", "Spawn zone"],
                  ["obstruction", "Obstruction"],
                ] as [Tool, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-label={label}
                  title={label}
                  aria-pressed={tool === value}
                  onClick={() => changeTool(value)}
                >
                  <ToolIcon name={value} />
                  <span>
                    {value === "select"
                      ? "Select"
                      : value === "spawn"
                        ? "Spawn"
                        : label}
                  </span>
                </button>
              ))}
            </div>
            <div
              className="editor-actions"
              role="group"
              aria-label="Editor actions"
            >
              <div
                className="studio-control-group"
                role="group"
                aria-label="History controls"
              >
                <button
                  className="studio-control"
                  onClick={undo}
                  disabled={disabled || !history.length}
                >
                  Undo
                </button>
                <button
                  className="studio-control"
                  onClick={redoChange}
                  disabled={disabled || !redo.length}
                >
                  Redo
                </button>
              </div>
              <span className="control-separator" aria-hidden="true" />
              <StudioPopover
                label="File"
                className="editor-file"
                disabled={disabled}
              >
                {(close) => (
                  <div className="file-actions">
                    <button
                      className="studio-control"
                      onClick={() => {
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
                        close();
                      }}
                    >
                      New layout
                    </button>
                    <button
                      className="studio-control"
                      onClick={() => {
                        if (commit(structuredClone(example))) {
                          selectElement(null);
                          setGesture(null);
                        }
                        close();
                      }}
                    >
                      Load example
                    </button>
                    <hr />
                    <button
                      className="studio-control"
                      onClick={() => {
                        close();
                        importInput.current?.click();
                      }}
                    >
                      Import JSON
                    </button>
                    <button
                      className="studio-control"
                      onClick={() => {
                        exportLayout();
                        close();
                      }}
                    >
                      Export JSON
                    </button>
                  </div>
                )}
              </StudioPopover>
              <span className="control-separator" aria-hidden="true" />
              <button
                type="button"
                className="studio-control"
                ref={propertiesButton}
                aria-expanded={propertiesOpen}
                aria-controls="editor-properties"
                onClick={() => setPropertiesOpen(!propertiesOpen)}
              >
                Properties
              </button>
              <input
                ref={importInput}
                hidden
                type="file"
                accept=".json,application/json"
                aria-label="Import layout JSON"
                onChange={(event) => void importLayout(event.target.files?.[0])}
              />
            </div>
          </div>
          <div className="editor-stage">
            <p className="editor-help">
              {tool === "select"
                ? "Drag objects or wall endpoints. Select an object to edit its properties."
                : tool === "wall"
                  ? "Drag to draw a wall at any angle. Nearby wall endpoints snap together."
                  : tool === "door" || tool === "exit"
                    ? `Click a wall to place ${tool === "exit" ? "an exit" : "a door"}. Select it to adjust its width.`
                    : `Drag a rectangle to place a ${tool === "spawn" ? "spawn zone" : "physical obstruction"}.`}
            </p>
            <div className="canvas-wrap editor-canvas-wrap">
              <canvas
                ref={canvas}
                width={1200}
                height={800}
                tabIndex={0}
                role="img"
                aria-label={`Editable floor plan, ${building.width} by ${building.height} metres. ${building.walls.length} walls, ${building.doors.length} doors, ${building.exits.length} exits, ${building.spawn_zones.length} spawn zones. Use layout tools to draw or the element inspector to edit.`}
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
                  building[kind].map((v, i) => (
                    <option key={v.id} value={`${kind}:${v.id}`}>
                      {kind === "spawn_zones"
                        ? "Spawn zone"
                        : kind.slice(0, -1)}{" "}
                      {i + 1} · {v.id.slice(0, 16)}
                    </option>
                  )),
                )}
              </select>
            </label>
            {selectedElement && selected ? (
              <div className="inspector-fields">
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
