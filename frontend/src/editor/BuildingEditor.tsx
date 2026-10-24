<<<<<<< HEAD
import { useEffect, useRef, useState, type PointerEvent } from "react";
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
=======
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
>>>>>>> 640f4251aaa873d72caf13cb12cc68bec8b5e328

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

<<<<<<< HEAD
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
=======
const tools: { id: EditorTool; label: string }[] = [
  { id: "wall", label: "Wall" },
  { id: "walkable", label: "Walkable" },
  { id: "door", label: "Door" },
  { id: "exit", label: "Exit" },
  { id: "erase", label: "Erase" },
];
>>>>>>> 640f4251aaa873d72caf13cb12cc68bec8b5e328

export function BuildingEditor({
  building,
  onChange,
  disabled = false,
}: BuildingEditorProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
<<<<<<< HEAD
  const importInput = useRef<HTMLInputElement>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<BuildingScenario[]>([]);
  const [redo, setRedo] = useState<BuildingScenario[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const selectedElement = selected
    ? building[selected.kind].find((v) => v.id === selected.id)
    : null;

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
    if (canvas.current)
      drawLayout(
        canvas.current,
        preview,
        selected,
        gesture && !gesture.selection
          ? {
              start: gesture.start,
              end: gesture.current,
              rectangle: tool !== "wall",
            }
          : undefined,
      );
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
        setSelected({ kind, id: opening.id });
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
      setSelected(selection);
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
      setSelected(null);
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
        setSelected({ kind: "walls", id });
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
          setSelected({ kind: "spawn_zones", id });
      } else if (
        commit({
          ...building,
          obstructions: [...building.obstructions, rectangle],
        })
      )
        setSelected({ kind: "obstructions", id });
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
    setSelected(null);
    setError("");
    onChange(previous);
  }
  function redoChange() {
    const next = redo.at(-1);
    if (!next) return;
    setHistory((items) => [...items, building]);
    setRedo((items) => items.slice(0, -1));
    setGesture(null);
    setSelected(null);
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
        setSelected(null);
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

=======
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

>>>>>>> 640f4251aaa873d72caf13cb12cc68bec8b5e328
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
<<<<<<< HEAD
        <span className="badge">Freeform · metres</span>
      </div>
      <fieldset className="editor-controls" disabled={disabled}>
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
              aria-pressed={tool === value}
              onClick={() => changeTool(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="editor-actions">
          <button onClick={undo} disabled={disabled || !history.length}>
            Undo
          </button>
          <button onClick={redoChange} disabled={disabled || !redo.length}>
            Redo
          </button>
          <button
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
                setSelected(null);
                setGesture(null);
              }
            }}
          >
            New layout
          </button>
          <button
            onClick={() => {
              if (commit(structuredClone(example))) {
                setSelected(null);
                setGesture(null);
              }
            }}
          >
            Load example
          </button>
          <button onClick={exportLayout}>Export JSON</button>
          <button onClick={() => importInput.current?.click()}>
            Import JSON
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
        <p className="editor-help">
          {tool === "select"
            ? "Select and drag an element. Drag a selected wall’s endpoint to reshape it. Use the inspector for precise measurements."
            : tool === "wall"
              ? "Drag to draw a wall at any angle. Nearby wall endpoints snap together."
              : tool === "door" || tool === "exit"
                ? `Click a wall to place ${tool === "exit" ? "an exit" : "a door"}. Select it to adjust its width.`
                : `Drag a rectangle to place a ${tool === "spawn" ? "spawn zone" : "physical obstruction"}.`}
        </p>
        <div className="editor-workspace">
          <div className="canvas-wrap editor-canvas-wrap">
            <canvas
              ref={canvas}
              width={1200}
              height={800}
              tabIndex={0}
              role="img"
              aria-label={`Editable floor plan, ${building.width} by ${building.height} metres. ${building.walls.length} walls, ${building.doors.length} doors, ${building.exits.length} exits, ${building.spawn_zones.length} spawn zones. Use layout tools to draw or the element inspector to edit.`}
              style={{
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
                  setSelected(null);
                }
                if (
                  (event.key === "Delete" || event.key === "Backspace") &&
                  selected
                ) {
                  event.preventDefault();
                  if (commit(removeElement(building, selected)))
                    setSelected(null);
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
                {building.walls.length} walls · {building.doors.length} doors ·{" "}
                {building.exits.length} exits · {building.spawn_zones.length}{" "}
                spawn zones
              </span>
              <span>
                {cursor
                  ? `${cursor.x.toFixed(2)}, ${cursor.y.toFixed(2)} m`
                  : "Continuous coordinates"}
              </span>
            </div>
          </div>
          <aside className="editor-inspector" aria-label="Element inspector">
            <h3>Inspector</h3>
            <label className="element-select">
              Selected element
              <select
                aria-label="Selected element"
                value={selected ? `${selected.kind}:${selected.id}` : ""}
                onChange={(event) => {
                  const [kind, ...parts] = event.target.value.split(":");
                  const id = parts.join(":");
                  setSelected(
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
                      setSelected(null);
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
            <div className="workspace-settings">
              <h3>Workspace</h3>
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
            </div>
          </aside>
        </div>
      </fieldset>
      {error && (
        <p className="editor-error" role="alert">
          {error}
        </p>
      )}
      <div className="legend">
=======
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
>>>>>>> 640f4251aaa873d72caf13cb12cc68bec8b5e328
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
<<<<<<< HEAD
        Layouts use continuous metre coordinates. Save your work with Export
        JSON; simulation and playback remain separate workstreams.
=======
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
>>>>>>> 640f4251aaa873d72caf13cb12cc68bec8b5e328
      </p>
    </section>
  );
}
