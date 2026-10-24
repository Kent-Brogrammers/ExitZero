import { hitOpening } from "./openings";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  gridSpacings,
  snapGridPoint,
  useDraftingPreferences,
} from "./drafting";
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
  project,
  wallLength,
  type Selection,
} from "./geometry";
import {
  combineSelection,
  toggleSelection,
  marqueeSelection,
  selectionBounds,
  moveSelection,
  removeSelection,
  resizeSelection,
  canResizeSelection,
} from "./selection";
import { drawLayout } from "./draw";
import "./BuildingEditor.css";

type Gesture = {
  start: Point;
  current: Point;
  base: BuildingScenario;
  selection?: Selection;
  items?: Selection[];
  marquee?: boolean;
  initial?: Selection[];
  endpoint?: "start" | "end";
  constrain?: boolean;
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
  const [drafting, setDrafting] = useDraftingPreferences();
  const canvas = useRef<HTMLCanvasElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const propertiesButton = useRef<HTMLButtonElement>(null);
  const savedLayout = useRef(JSON.stringify(building));
  const [tool, setTool] = useState<EditorTool>("select");
  const [selections, setSelections] = useState<Selection[]>([]);
  const selected = selections.at(-1) ?? null;
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<BuildingScenario[]>([]);
  const [redo, setRedo] = useState<BuildingScenario[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const selectedElement = selected
    ? (building[selected.kind] ?? []).find((v) => v.id === selected.id)
    : null;

  function closeProperties() {
    setPropertiesOpen(false);
    propertiesButton.current?.focus();
  }

  function selectElement(selection: Selection | null) {
    setSelections(selection ? [selection] : []);
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
  function world(event: {
    currentTarget: HTMLCanvasElement;
    clientX: number;
    clientY: number;
  }): Point {
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
    if (drafting.snap)
      return snapGridPoint(
        point,
        gridSpacings[drafting.spacing].metres,
        building,
      );
    const endpoints = building.walls.flatMap((wall) => [wall.start, wall.end]);
    return endpoints.find((p) => distance(point, p) < tolerance()) ?? point;
  }
  function hit(point: Point): Selection | null {
    const opening = hitOpening(building, point, tolerance());
    if (opening) return opening;
    const wall = building.walls.find(
      (w) =>
        project(point, w).distance < Math.max(tolerance(), w.thickness / 2),
    );
    if (wall) return { kind: "walls", id: wall.id };
    for (const kind of ["obstructions", "spawn_zones", "stair_areas"] as const)
      for (const rectangle of building[kind] ?? []) {
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
      next.walls.find((w) => w.id === g.selection!.id)![g.endpoint] = snap(
        g.current,
      );
      return next;
    }
    let delta = { x: g.current.x - g.start.x, y: g.current.y - g.start.y };
    if (drafting.snap) {
      const bounds = selectionBounds(g.base, g.items ?? [g.selection]);
      if (bounds) {
        const p = snapGridPoint(
          { x: bounds.x + delta.x, y: bounds.y + delta.y },
          gridSpacings[drafting.spacing].metres,
          building,
        );
        delta = { x: p.x - bounds.x, y: p.y - bounds.y };
      }
    }
    return moveSelection(g.base, g.items ?? [g.selection], delta);
  }
  const preview = gesture?.selection ? moved(gesture) : building;
  const displaySelection = gesture?.marquee
    ? combineSelection(
        gesture.initial ?? [],
        marqueeSelection(
          building,
          dragRectangle(gesture.start, gesture.current, building),
        ),
      )
    : selections;
  const groupBounds = selectionBounds(building, selections);
  function deleteSelected() {
    if (selections.length && commit(removeSelection(building, selections)))
      selectElement(null);
  }
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const redraw = () =>
      drawLayout(
        element,
        preview,
        gesture?.marquee
          ? combineSelection(
              gesture.initial ?? [],
              marqueeSelection(
                building,
                dragRectangle(gesture.start, gesture.current, building),
              ),
            )
          : selections,
        gesture && !gesture.selection
          ? {
              start: gesture.start,
              end: gesture.current,
              shape: gesture.marquee ? "marquee" : tool,
              constrain: gesture.constrain,
            }
          : undefined,
        window.devicePixelRatio,
        undefined,
        { grid: drafting },
      );
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(element);
    window.addEventListener("resize", redraw);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", redraw);
    };
  }, [building, preview, selections, gesture, tool, theme, drafting]);

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
      }
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "select") {
      let item = hit(point);
      let endpoint: "start" | "end" | undefined;
      if (
        selections.length === 1 &&
        selected?.kind === "walls" &&
        !event.shiftKey
      ) {
        const wall = building.walls.find((w) => w.id === selected.id);
        if (wall) {
          if (distance(point, wall.start) < tolerance()) endpoint = "start";
          else if (distance(point, wall.end) < tolerance()) endpoint = "end";
          if (endpoint) item = selected;
        }
      }
      if (item) {
        if (event.shiftKey) {
          setSelections(toggleSelection(selections, item));
          return;
        }
        const items = selections.some((v) => v.id === item!.id)
          ? selections
          : [item];
        setSelections(items);
        setGesture({
          start: point,
          current: point,
          base: building,
          selection: item,
          items,
          endpoint,
        });
      } else {
        setGesture({
          start: point,
          current: point,
          base: building,
          marquee: true,
          initial: event.shiftKey ? selections : [],
        });
      }
    } else {
      const start = tool === "wall" || drafting.snap ? snap(point) : point;
      selectElement(null);
      setGesture({
        start,
        current: start,
        base: building,
        constrain: event.shiftKey,
      });
    }
  }
  function pointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const point = world(event);
    setCursor(point);
    if (gesture)
      setGesture({
        ...gesture,
        current:
          !gesture.selection &&
          !gesture.marquee &&
          (tool === "wall" || drafting.snap)
            ? snap(point)
            : point,
        constrain: event.shiftKey,
      });
  }
  function pointerUp(event: PointerEvent<HTMLCanvasElement>) {
    if (!gesture) return;
    const g = {
      ...gesture,
      current:
        !gesture.selection &&
        !gesture.marquee &&
        (tool === "wall" || drafting.snap)
          ? snap(world(event))
          : world(event),
      constrain: event.shiftKey,
    };
    setGesture(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (g.marquee) {
      setSelections(
        distance(g.start, g.current) < 0.02
          ? (g.initial ?? [])
          : combineSelection(
              g.initial ?? [],
              marqueeSelection(
                building,
                dragRectangle(g.start, g.current, building),
              ),
            ),
      );
      return;
    }
    if (distance(g.start, g.current) < 0.02) return;
    if (g.selection) {
      commit(moved(g));
      return;
    }
    if (isWallTool(tool)) {
      const next = addWallShape(
        building,
        tool,
        g.start,
        g.current,
        undefined,
        g.constrain,
      );
      if (commit(next))
        selectElement({
          kind: "walls",
          id: next.walls[building.walls.length]!.id,
        });
    } else if (tool === "stairs") {
      const area = {
        id: `stairs_${crypto.randomUUID()}`,
        name: nextObjectName(building, "stair_areas"),
        ...dragRectangle(g.start, g.current, building),
        orientation_degrees: 0 as const,
      };
      if (
        commit({
          ...building,
          stair_areas: [...(building.stair_areas ?? []), area],
        })
      )
        selectElement({ kind: "stair_areas", id: area.id });
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
      const next = addObject(building, g.start, g.current, !!g.constrain);
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
    const element = (next[selected.kind] ?? []).find(
      (v) => v.id === selected.id,
    )!;
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
  function replaceLayout(next: BuildingScenario, label: string) {
    if (
      JSON.stringify(building) !== savedLayout.current &&
      !window.confirm(
        `Replace your edited building with ${label}? Export JSON first to keep a file. Undo can restore the previous layout.`,
      )
    )
      return;
    if (commit(next)) {
      savedLayout.current = JSON.stringify(next);
      selectElement(null);
      setGesture(null);
    }
  }
  function exportLayout() {
    savedLayout.current = JSON.stringify(building);
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
      replaceLayout(value as BuildingScenario, "the imported layout");
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
              onNew={() =>
                replaceLayout(
                  {
                    ...building,
                    walls: [],
                    doors: [],
                    exits: [],
                    spawn_zones: [],
                    blocked_exit_ids: [],
                    obstructions: [],
                    ...(building.stair_areas ? { stair_areas: [] } : {}),
                  },
                  "an empty layout",
                )
              }
              onExample={() =>
                replaceLayout(structuredClone(example), "the example building")
              }
              onPreset={(preset) =>
                replaceLayout(structuredClone(preset.building), preset.label)
              }
              onImport={() => importInput.current?.click()}
              onExport={exportLayout}
              onProperties={() => setPropertiesOpen(!propertiesOpen)}
              drafting={drafting}
              onDrafting={setDrafting}
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
            {selections.length > 0 && (
              <p
                className="editor-selection-feedback"
                role="status"
                title={selected ? objectName(building, selected) : ""}
              >
                {selections.length > 1
                  ? `${selections.length} selected · drag to move · Properties to resize`
                  : `Selected: ${objectName(building, selected!)}`}
              </p>
            )}
            <p className="editor-help">
              {tool === "select"
                ? "Drag objects or wall endpoints. Drag empty space for marquee; Shift adds objects. Properties opens only on request."
                : tool === "wall"
                  ? "Drag a straight wall at any angle. Nearby endpoints snap together."
                  : tool === "wall-rectangle"
                    ? "Drag opposite corners freely; Shift makes a square. Creates four independently editable walls."
                    : tool === "wall-circle"
                      ? "Drag opposite corners for an ellipse; Shift makes a circle. Saves 32 actual straight segments."
                      : tool === "door" || tool === "exit"
                        ? `Click a wall to place ${tool === "exit" ? "an exit" : "a door"}. Adjust its width in Properties.`
                        : tool === "stairs"
                          ? "Drag a walkable stair-area marker. It does not connect floors or block occupants."
                          : tool === "spawn"
                            ? "Drag a spawn area, then set its name and occupant count in Properties."
                            : "Drag freely for a rectangular object; hold Shift for a square. Names and dimensions are editable in Properties."}
            </p>
            <div className="canvas-wrap editor-canvas-wrap">
              <canvas
                ref={canvas}
                width={1200}
                height={800}
                tabIndex={0}
                data-selected-count={displaySelection.length}
                role="img"
                aria-label={`Editable floor plan, ${building.width} by ${building.height} metres. ${building.walls.length} walls, ${building.doors.length} doors, ${building.exits.length} exits, ${building.spawn_zones.length} spawn zones, ${building.obstructions.length} obstructions. ${selections.length > 1 ? `${selections.length} selected objects. ` : selectedElement && selected ? `Selected: ${objectName(building, selected)}. ` : ""}Use layout tools to draw or the element inspector to edit.`}
                style={{
                  aspectRatio: "3 / 2",
                  cursor:
                    tool === "select"
                      ? gesture
                        ? "grabbing"
                        : "default"
                      : "crosshair",
                }}
                onDoubleClick={(event) => {
                  const target = hit(world(event));
                  if (target) {
                    if (!selections.some((s) => s.id === target.id))
                      selectElement(target);
                    setPropertiesOpen(true);
                    setError("");
                  }
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
                    if (propertiesOpen) closeProperties();
                    else selectElement(null);
                  }
                  if (
                    (event.key === "Delete" || event.key === "Backspace") &&
                    selected
                  ) {
                    event.preventDefault();
                    deleteSelected();
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
                    : drafting.snap
                      ? `Snap ${gridSpacings[drafting.spacing].label} · geometry in metres`
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
                    "stair_areas",
                  ] as const
                ).flatMap((kind) =>
                  (building[kind] ?? []).map((v) => (
                    <option key={v.id} value={`${kind}:${v.id}`}>
                      {objectName(building, { kind, id: v.id })} ·{" "}
                      {v.id.slice(0, 16)}
                    </option>
                  )),
                )}
              </select>
            </label>
            {selections.length > 1 ? (
              <div className="inspector-fields">
                <p className="note">
                  {selections.length} objects selected. Marquee requires full
                  footprint containment. Shift-click adds or removes an object.
                </p>
                {groupBounds && canResizeSelection(building, selections) ? (
                  <>
                    <p className="note">
                      Resize centreline/rectangle bounds. Wall thickness and
                      occupant counts stay fixed; attached openings scale with
                      their parent walls.
                    </p>
                    {groupBounds.width > 0 && (
                      <NumberField
                        label="Selection width"
                        value={groupBounds.width}
                        onCommit={(value) =>
                          commit(
                            resizeSelection(
                              building,
                              selections,
                              value,
                              groupBounds.height,
                            ),
                          )
                        }
                      />
                    )}
                    {groupBounds.height > 0 && (
                      <NumberField
                        label="Selection height"
                        value={groupBounds.height}
                        onCommit={(value) =>
                          commit(
                            resizeSelection(
                              building,
                              selections,
                              groupBounds.width,
                              value,
                            ),
                          )
                        }
                      />
                    )}
                  </>
                ) : (
                  <p className="note">
                    Include the parent walls to resize openings as a group.
                  </p>
                )}
                <button className="delete-button" onClick={deleteSelected}>
                  Delete selection
                </button>
              </div>
            ) : selectedElement && selected ? (
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
                {selected.kind === "stair_areas" && (
                  <>
                    <p className="note">
                      Walkable single-floor marker only. It does not block
                      occupants or connect floors.
                    </p>
                    <label className="element-select">
                      Orientation
                      <select
                        aria-label="Stair orientation"
                        value={
                          building.stair_areas?.find(
                            (area) => area.id === selected.id,
                          )?.orientation_degrees ?? 0
                        }
                        onChange={(event) =>
                          changeSelected(
                            "orientation_degrees",
                            Number(event.target.value),
                          )
                        }
                      >
                        {[0, 90, 180, 270].map((angle) => (
                          <option key={angle} value={angle}>
                            {angle}°
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                <p className="note">
                  {"wall_id" in selectedElement
                    ? `Attached to ${selectedElement.wall_id}. Touching available openings form a continuous gap; blocked exits stay solid. IDs stay separate.`
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
                    deleteSelected();
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
