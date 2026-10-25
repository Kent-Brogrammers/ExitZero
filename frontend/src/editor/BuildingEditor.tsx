import DxfImport from "./dxf/DxfImport";
import { DisasterControls } from "./DisasterControls";
import {
  addFurniture,
  furnitureKind,
  furniturePresets,
  type FurnitureKind,
} from "./furniture";
import { hitOpening } from "./openings";
import { openingStartsBlocked, setOpeningBlocked } from "./openingState";
import { mergeEditedOpenings, snapOpeningToNeighbor } from "./doorEditing";
import {
  addFreehandWalls,
  curvePolyline,
  sampleCurve,
  MAX_CURVE_SAMPLES,
  CURVE_SAMPLE_METRES,
} from "./freehand";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent,
  type Ref,
} from "react";
import {
  gridSpacings,
  snapGridPoint,
  useDraftingPreferences,
} from "./drafting";
import { ObjectNameField } from "./ObjectNameField";
import { WindowProperties } from "./WindowProperties";
import { objectName, nextObjectName, renameObject } from "./names";
import { EditorUtilityRail } from "./EditorUtilityRail";
import { EditorDrawingRail } from "./EditorDrawingRail";
import { addObject, addWallShape, addSpawnZone, dragRectangle } from "./shapes";
import { useStudioTheme } from "../styles/appearance";
import { isWallTool, type EditorTool } from "./tools";
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
  marqueeSelection,
  selectionBounds,
  moveSelection,
  removeSelection,
  resizeSelection,
  canResizeSelection,
} from "./selection";
import { drawLayout } from "./draw";
import "./BuildingEditor.css";

type EditorSnapshot = {
  building: BuildingScenario;
  furniture: Map<string, FurnitureKind>;
};

type Gesture = {
  start: Point;
  current: Point;
  base: BuildingScenario;
  selection?: Selection;
  hazard?: boolean;
  items?: Selection[];
  marquee?: boolean;
  initial?: Selection[];
  endpoint?: "start" | "end";
  constrain?: boolean;
  curve?: Point[];
  tracing?: boolean;
  overflow?: boolean;
  spawnId?: string;
};
export interface BuildingEditorHandle {
  applyBuilding: (next: BuildingScenario) => boolean;
}

interface BuildingEditorProps {
  building: BuildingScenario;
  onChange: (building: BuildingScenario) => void;
  disabled?: boolean;
  savedLayoutJson?: string;
  onSaved?: (building: BuildingScenario) => void;
  editorRef?: Ref<BuildingEditorHandle>;
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
  savedLayoutJson,
  onSaved,
  editorRef,
}: BuildingEditorProps) {
  const theme = useStudioTheme();
  const [drafting, setDrafting] = useDraftingPreferences();
  const editor = useRef<HTMLElement>(null);
  const [expandedView, setExpandedView] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const dxfDialog = useRef<HTMLDialogElement>(null);
  const propertiesButton = useRef<HTMLButtonElement>(null);
  const savedLayout = useRef(JSON.stringify(building));
  const [furnitureSymbols, setFurnitureSymbols] = useState(
    new Map<string, FurnitureKind>(),
  );
  const curveGroups = useRef(new Map<string, readonly string[]>());
  const openingId = useRef(`door_${crypto.randomUUID()}`);
  const [tool, setTool] = useState<EditorTool>("select");
  const [selections, setSelections] = useState<Selection[]>([]);
  const selected = selections.at(-1) ?? null;
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<EditorSnapshot[]>([]);
  const [redo, setRedo] = useState<EditorSnapshot[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const selectedElement = selected
    ? (building[selected.kind] ?? []).find((v) => v.id === selected.id)
    : null;

  useEffect(() => {
    const update = () =>
      setExpandedView(document.fullscreenElement === editor.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  async function toggleExpandedView() {
    if (!editor.current) return;
    setGesture(null);
    try {
      if (document.fullscreenElement === editor.current)
        await document.exitFullscreen();
      else await editor.current.requestFullscreen();
    } catch {
      setError(
        "Fullscreen is unavailable in this browser. Canvas size controls still work.",
      );
    }
  }

  function snapshot(): EditorSnapshot {
    return { building, furniture: new Map(furnitureSymbols) };
  }

  function restore(previous: EditorSnapshot) {
    setFurnitureSymbols(new Map(previous.furniture));
    onChange(previous.building);
  }

  function changeFurnitureStyle(kind: FurnitureKind | "") {
    if (!selected || selected.kind !== "obstructions") return;
    setHistory((items) => [...items.slice(-49), snapshot()]);
    setRedo([]);
    const next = new Map(furnitureSymbols);
    if (kind) next.set(selected.id, kind);
    else next.delete(selected.id);
    setFurnitureSymbols(next);
    setNotice("Drawing style updated · session only · geometry unchanged.");
  }

  function closeProperties() {
    setPropertiesOpen(false);
    propertiesButton.current?.focus();
  }

  function selectElement(selection: Selection | null) {
    setSelections(selection ? [selection] : []);
  }

  function commit(
    next: BuildingScenario,
    mergeOpenings = false,
    afterSelection?: Selection[],
  ) {
    const edit = mergeOpenings
      ? mergeEditedOpenings(
          building,
          next,
          selected?.kind === "doors" || selected?.kind === "exits"
            ? selected.id
            : undefined,
        )
      : null;
    if (edit?.error) {
      setError(edit.error);
      return false;
    }
    if (edit) next = edit.building;
    const problem = buildingError(next, false);
    if (problem) {
      setError(problem);
      return false;
    }
    setHistory((items) => [...items.slice(-49), snapshot()]);
    setRedo([]);
    setError("");
    setNotice(
      edit?.replacements.size
        ? "Openings merged · Undo restores the originals."
        : "",
    );
    if (afterSelection || edit?.replacements.size) {
      const mapped = (afterSelection ?? selections).map((item) =>
        item.kind === "doors" || item.kind === "exits"
          ? { ...item, id: edit?.replacements.get(item.id) ?? item.id }
          : item,
      );
      setSelections(
        mapped.filter((v, i) => mapped.findIndex((m) => m.id === v.id) === i),
      );
    }
    onChange(next);
    return true;
  }
  useImperativeHandle(editorRef, () => ({
    applyBuilding(next) {
      setGesture(null);
      return commit(next, false, []);
    },
  }));

  function changeTool(next: EditorTool) {
    setPropertiesOpen(false);
    setTool(next);
    setNotice("");
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
    for (const kind of [
      "obstructions",
      "spawn_zones",
      "stair_areas",
      "tornado_zones",
    ] as const)
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
  function moved(g: Gesture): { building: BuildingScenario; snapped: boolean } {
    if (!g.selection || (!g.endpoint && distance(g.start, g.current) < 0.02))
      return { building: g.base, snapped: false };
    if (g.endpoint) {
      const next = structuredClone(g.base);
      next.walls.find((w) => w.id === g.selection!.id)![g.endpoint] = snap(
        g.current,
      );
      return { building: next, snapped: false };
    }
    let delta = { x: g.current.x - g.start.x, y: g.current.y - g.start.y };
    const items = g.items ?? [g.selection];
    if (
      drafting.snap &&
      items.length === 1 &&
      (g.selection.kind === "doors" || g.selection.kind === "exits")
    ) {
      const snapped = snapOpeningToNeighbor(
        moveSelection(g.base, items, delta),
        g.selection.kind,
        g.selection.id,
        drafting.doorMergeTolerance,
      );
      if (snapped.snapped) return snapped;
    }
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
    return { building: moveSelection(g.base, items, delta), snapped: false };
  }
  function openingAt(
    point: Point,
    kind: "doors" | "exits" | "windows",
    id: string,
  ) {
    const closest = building.walls
      .map((wall) => ({ wall, ...project(point, wall) }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (!closest || closest.distance > tolerance()) return null;
    const width = Math.min(1.2, wallLength(closest.wall));
    const opening = {
      id,
      name: nextObjectName(building, kind),
      wall_id: closest.wall.id,
      offset: clamp(
        closest.offset - width / 2,
        0,
        wallLength(closest.wall) - width,
      ),
      width,
    };
    const candidate = {
      ...building,
      [kind]: [...(building[kind] ?? []), opening],
    };
    return {
      opening,
      ...(drafting.snap && kind !== "windows"
        ? snapOpeningToNeighbor(
            candidate,
            kind,
            id,
            drafting.doorMergeTolerance,
          )
        : { building: candidate, snapped: false }),
    };
  }
  function curveDraft(g: Gesture) {
    const raw = [...(g.curve ?? [])];
    const endpoint = drafting.snap ? snap(g.current) : g.current;
    if (drafting.snap && raw.length > 1) raw[raw.length - 1] = endpoint;
    else if (raw.length && distance(raw.at(-1)!, endpoint) > 1e-8)
      raw.push(endpoint);
    return curvePolyline(raw, 500 - building.walls.length);
  }
  function finishCurve(g: Gesture) {
    setGesture(null);
    const result = curveDraft(g);
    if (g.overflow || result.error) {
      setError(
        g.overflow
          ? "Curve sample limit reached; draw shorter sections."
          : result.error!,
      );
      return;
    }
    const next = addFreehandWalls(building, result.points);
    const ids = next.walls.slice(building.walls.length).map((w) => w.id);
    if (
      commit(
        next,
        false,
        ids.map((id) => ({ kind: "walls", id })),
      )
    ) {
      for (const id of ids) curveGroups.current.set(id, ids);
      setNotice(
        "Freehand group · Alt-click for one segment · JSON saves individual walls.",
      );
    }
  }
  function curveMembers(item: Selection): Selection[] {
    const ids =
      item.kind === "walls" ? curveGroups.current.get(item.id) : undefined;
    return ids
      ? ids
          .filter((id) => building.walls.some((w) => w.id === id))
          .map((id) => ({ kind: "walls", id }))
      : [item];
  }
  function movedHazard(g: Gesture): BuildingScenario {
    const hazard = g.base.disaster;
    if (!hazard) return g.base;
    const center = {
      x: clamp(hazard.center.x + g.current.x - g.start.x, 0, g.base.width),
      y: clamp(hazard.center.y + g.current.y - g.start.y, 0, g.base.height),
    };
    return { ...g.base, disaster: { ...hazard, center } };
  }
  const movement = gesture?.hazard
    ? { building: movedHazard(gesture), snapped: false }
    : gesture?.selection
      ? moved(gesture)
      : null;
  const placement =
    !gesture &&
    (tool === "door" || tool === "exit" || tool === "window") &&
    cursor
      ? openingAt(
          cursor,
          tool === "window" ? "windows" : tool === "door" ? "doors" : "exits",
          openingId.current,
        )
      : null;
  const draftEdit = movement ?? placement;
  const openingPreview = draftEdit
    ? mergeEditedOpenings(
        building,
        draftEdit.building,
        selected?.kind === "doors" || selected?.kind === "exits"
          ? selected.id
          : undefined,
      )
    : null;
  const preview = openingPreview?.error
    ? (draftEdit?.building ?? building)
    : (openingPreview?.building ?? building);
  const freehand = gesture?.curve ? curveDraft(gesture) : null;
  const spawnDraft =
    tool === "spawn" && gesture && !gesture.selection
      ? addSpawnZone(
          gesture.base,
          gesture.start,
          gesture.current,
          !!gesture.constrain,
          gesture.spawnId,
        )
      : null;
  const spawnProblem = spawnDraft ? buildingError(spawnDraft, false) : null;
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
          : placement
            ? [
                {
                  kind:
                    tool === "window"
                      ? "windows"
                      : tool === "exit"
                        ? "exits"
                        : "doors",
                  id:
                    openingPreview?.replacements.get(placement.opening.id) ??
                    placement.opening.id,
                },
              ]
            : selections.map((item) =>
                item.kind === "doors" || item.kind === "exits"
                  ? {
                      ...item,
                      id: openingPreview?.replacements.get(item.id) ?? item.id,
                    }
                  : item,
              ),
        gesture && !gesture.selection && !gesture.hazard
          ? {
              start: gesture.start,
              end: gesture.current,
              shape: gesture.marquee ? "marquee" : tool,
              constrain: gesture.constrain,
              points: freehand?.points,
              invalid: !!spawnProblem,
            }
          : undefined,
        window.devicePixelRatio,
        undefined,
        {
          grid: drafting,
          furniture: furnitureSymbols,
          showLabels: tool === "select" && !gesture,
          showDimensions: tool === "select" && !gesture,
        },
      );
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(element);
    window.addEventListener("resize", redraw);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", redraw);
    };
  }, [
    building,
    preview,
    selections,
    gesture,
    tool,
    theme,
    drafting,
    freehand,
    placement,
    openingPreview,
    furnitureSymbols,
    spawnProblem,
  ]);

  function pointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (disabled || event.button !== 0) return;
    event.currentTarget.focus({ preventScroll: true });
    const point = world(event);
    setError("");
    setNotice("");
    if (tool === "hazard" && building.disaster) {
      commit({
        ...building,
        disaster: { ...building.disaster, center: point },
      });
      setNotice("Hazard location updated. Agents discover it during the run.");
      return;
    }
    if (tool === "wall-freehand") {
      if (gesture?.curve && gesture.tracing) {
        finishCurve({
          ...gesture,
          current: point,
          curve: sampleCurve(gesture.curve, point),
        });
      } else {
        const start = snap(point);
        selectElement(null);
        setGesture({
          start: point,
          current: point,
          base: building,
          curve: [start],
        });
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (tool === "door" || tool === "exit" || tool === "window") {
      const kind =
        tool === "window" ? "windows" : tool === "door" ? "doors" : "exits";
      const candidate = openingAt(point, kind, openingId.current);
      if (!candidate) {
        setError("Click near a wall to place an opening.");
        return;
      }
      if (
        commit(candidate.building, true, [{ kind, id: candidate.opening.id }])
      )
        openingId.current = `opening_${crypto.randomUUID()}`;
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "select") {
      if (
        building.disaster &&
        distance(point, building.disaster.center) <=
          Math.max(tolerance(), Math.min(building.disaster.radius, 0.75))
      ) {
        selectElement(null);
        setNotice(
          "Moving hazard · release to place · Undo restores its location",
        );
        setGesture({
          start: point,
          current: point,
          base: building,
          hazard: true,
        });
        return;
      }
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
          const members = event.altKey ? [item] : curveMembers(item);
          setSelections(
            members.every((m) => selections.some((v) => v.id === m.id))
              ? selections.filter((v) => !members.some((m) => m.id === v.id))
              : combineSelection(selections, members),
          );
          return;
        }
        const items = event.altKey
          ? [item]
          : selections.some((v) => v.id === item!.id)
            ? selections
            : endpoint
              ? [item]
              : curveMembers(item);
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
        spawnId: tool === "spawn" ? `spawn_${crypto.randomUUID()}` : undefined,
      });
    }
  }
  function pointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const point = world(event);
    setCursor(point);
    setGesture((g) => {
      if (!g) return g;
      if (g.curve)
        return {
          ...g,
          current: point,
          curve: sampleCurve(g.curve, point),
          overflow:
            g.overflow ||
            (g.curve.length >= MAX_CURVE_SAMPLES &&
              distance(g.curve.at(-1)!, point) >= CURVE_SAMPLE_METRES),
        };
      return {
        ...g,
        current:
          !g.selection &&
          !g.hazard &&
          !g.marquee &&
          (tool === "wall" || drafting.snap)
            ? snap(point)
            : point,
        constrain: event.shiftKey,
      };
    });
  }

  function pointerUp(event: PointerEvent<HTMLCanvasElement>) {
    if (!gesture) return;
    if (gesture.curve) {
      const point = world(event);
      const g = {
        ...gesture,
        current: point,
        curve: sampleCurve(gesture.curve, point),
      };
      const dragged =
        g.curve.slice(1).some((p) => distance(p, g.start) >= 0.1) ||
        distance(point, g.start) >= 0.1;
      if (!dragged && !g.tracing)
        setGesture({ ...g, curve: [g.curve[0]!], tracing: true });
      else finishCurve(g);
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    const g = {
      ...gesture,
      current:
        !gesture.selection &&
        !gesture.hazard &&
        !gesture.marquee &&
        (tool === "wall" || drafting.snap)
          ? snap(world(event))
          : world(event),
      constrain: event.shiftKey,
    };
    setGesture(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (g.hazard) {
      if (distance(g.start, g.current) >= 0.02 && commit(movedHazard(g)))
        setNotice("Hazard moved · Undo restores its previous location");
      else setNotice("");
      return;
    }
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
    const furniture = furnitureKind(tool);
    if (furniture) {
      const next = addFurniture(
        building,
        furniture,
        g.start,
        distance(g.start, g.current) < 0.02 ? undefined : g.current,
      );
      const id = next.obstructions.at(-1)!.id;
      if (commit(next, false, [{ kind: "obstructions", id }])) {
        setFurnitureSymbols(new Map(furnitureSymbols).set(id, furniture));
        setNotice(
          `${furniturePresets[furniture].label} placed · rectangular obstacle · session-only style`,
        );
      }
      return;
    }
    if (distance(g.start, g.current) < 0.02) return;
    if (g.selection) {
      commit(moved(g).building, true);
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
    } else if (tool === "tornado-zone") {
      const zone = {
        id: `shelter_${crypto.randomUUID()}`,
        name: nextObjectName(building, "tornado_zones"),
        ...dragRectangle(g.start, g.current, building),
      };
      if (
        commit({
          ...building,
          tornado_zones: [...(building.tornado_zones ?? []), zone],
        })
      )
        selectElement({ kind: "tornado_zones", id: zone.id });
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
      const next = addSpawnZone(
        building,
        g.start,
        g.current,
        !!g.constrain,
        g.spawnId,
      );
      const zone = next.spawn_zones.at(-1)!;
      if (commit(next)) selectElement({ kind: "spawn_zones", id: zone.id });
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
    commit(
      next,
      (selected.kind === "doors" || selected.kind === "exits") &&
        (field === "width" || field === "offset"),
    );
  }
  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setNotice("");
    setRedo((items) => [...items, snapshot()]);
    setHistory((items) => items.slice(0, -1));
    setGesture(null);
    selectElement(null);
    setError("");
    restore(previous);
  }
  function redoChange() {
    const next = redo.at(-1);
    if (!next) return;
    setNotice("");
    setHistory((items) => [...items, snapshot()]);
    setRedo((items) => items.slice(0, -1));
    setGesture(null);
    selectElement(null);
    setError("");
    restore(next);
  }
  function replaceLayout(next: BuildingScenario, label: string) {
    if (
      JSON.stringify(building) !== (savedLayoutJson ?? savedLayout.current) &&
      !window.confirm(
        `Replace your edited building with ${label}? Export JSON first to keep a file. Undo can restore the previous layout.`,
      )
    )
      return false;
    if (commit(next)) {
      curveGroups.current.clear();
      setFurnitureSymbols(new Map());
      savedLayout.current = JSON.stringify(next);
      onSaved?.(next);
      selectElement(null);
      setGesture(null);

      return true;
    }
    return false;
  }
  function exportLayout() {
    savedLayout.current = JSON.stringify(building);
    onSaved?.(building);
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
      ref={editor}
      className="panel editor-panel"
      id="building"
      aria-labelledby="building-title"
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && expandedView) {
          event.preventDefault();
          event.stopPropagation();
          void toggleExpandedView();
        }
      }}
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">01 / Building</p>
          <h2 id="building-title">Build your floor plan</h2>
        </div>
        <span className="badge">Freeform · metres</span>
      </div>
      <DxfImport
        base={building}
        disabled={disabled}
        dialogRef={dxfDialog}
        onApply={(next) => replaceLayout(next, "the reviewed DXF layout")}
      />
      <fieldset className="editor-controls" disabled={disabled}>
        <DisasterControls
          building={building}
          onChange={(next) => {
            commit(next);
            if (!next.disaster && tool === "hazard") changeTool("select");
          }}
          onLocate={() => changeTool("hazard")}
        />
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
                    ...(building.windows ? { windows: [] } : {}),
                    spawn_zones: [],
                    blocked_exit_ids: [],
                    ...(building.opening_events ? { opening_events: [] } : {}),
                    obstructions: [],
                    ...(building.stair_areas ? { stair_areas: [] } : {}),
                    tornado_zones: [],
                    disaster: undefined,
                  },
                  "an empty layout",
                )
              }
              onImport={() => importInput.current?.click()}
              onImportDxf={() => dxfDialog.current?.showModal()}
              onExport={exportLayout}
              onProperties={() => setPropertiesOpen(!propertiesOpen)}
              canvasControls={
                <div className="canvas-size-controls">
                  <h3>Drawing area</h3>
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
                  <button
                    type="button"
                    className="studio-control"
                    disabled={building.width >= 1000 && building.height >= 1000}
                    onClick={() =>
                      commit({
                        ...building,
                        width: Math.min(
                          1000,
                          Math.ceil(building.width * 125) / 100,
                        ),
                        height: Math.min(
                          1000,
                          Math.ceil(building.height * 125) / 100,
                        ),
                      })
                    }
                  >
                    Expand drawing area +25%
                  </button>
                  <p className="note">
                    Up to 1,000 m per side. Existing objects keep their size and
                    position. Undo restores the previous area.
                  </p>
                  <hr />
                  <button
                    type="button"
                    className="studio-control"
                    aria-pressed={expandedView}
                    onClick={() => void toggleExpandedView()}
                  >
                    {expandedView ? "Restore view" : "Expand view"}
                  </button>
                  <p className="note">
                    Fullscreen drawing. Press Esc to return.
                  </p>
                </div>
              }
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
            {(draftEdit?.snapped || notice || selections.length > 0) && (
              <p
                className="editor-selection-feedback"
                role="status"
                title={selected ? objectName(building, selected) : ""}
              >
                {draftEdit?.snapped
                  ? "Snap preview · confirm placement to merge"
                  : notice
                    ? notice
                    : selections.length > 1
                      ? `${selections.length} selected`
                      : `Selected: ${objectName(building, selected!)}`}
              </p>
            )}
            <p className={`editor-help${spawnProblem ? " is-invalid" : ""}`}>
              {furnitureKind(tool)
                ? "Click to place or drag a footprint. Furniture blocks its full rectangle."
                : tool === "hazard"
                  ? "Click to set the hazard's origin. Agents learn its location during the run."
                  : tool === "tornado-zone"
                    ? "Drag a safe shelter area for tornado response."
                    : tool === "select"
                      ? "Drag objects or a hazard’s centre marker to move or marquee select · Shift-click to add · Double-click for Properties"
                      : tool === "wall-freehand"
                        ? freehand?.error &&
                          gesture?.curve &&
                          gesture.curve.length > 1
                          ? freehand.error
                          : "Drag or click–trace–click · Escape cancels · Alt-click selects one segment"
                        : tool === "wall"
                          ? "Drag a straight wall at any angle. Nearby endpoints snap together."
                          : tool === "wall-rectangle"
                            ? "Drag opposite corners · Shift for square · Creates four walls"
                            : tool === "wall-circle"
                              ? "Drag an ellipse · Shift for circle · Saves 32 connected wall segments"
                              : tool === "door" ||
                                  tool === "exit" ||
                                  tool === "window"
                                ? `Click a wall to place ${tool === "exit" ? "an exit" : tool === "window" ? "a window" : "a door"}. Adjust its width in Properties.`
                                : tool === "stairs"
                                  ? "Drag a walkable stair-area marker. It does not connect floors or block occupants."
                                  : tool === "spawn"
                                    ? (spawnProblem ??
                                      (spawnDraft
                                        ? `${spawnDraft.spawn_zones.at(-1)!.width.toFixed(2)} × ${spawnDraft.spawn_zones.at(-1)!.height.toFixed(2)} m · ${spawnDraft.spawn_zones.at(-1)!.count} occupants · Release to place`
                                        : "Drag a rectangular spawn area · Shift for square · Set occupants in Properties"))
                                    : "Drag a rectangle · Shift for square · Edit dimensions in Properties"}
            </p>
            <div className="canvas-wrap editor-canvas-wrap">
              <canvas
                data-world-canvas
                ref={canvas}
                width={1200}
                height={800}
                tabIndex={0}
                data-selected-count={displaySelection.length}
                role="img"
                aria-label={`Editable floor plan, ${building.width} by ${building.height} metres. ${building.walls.length} walls, ${building.doors.length} doors, ${building.exits.length} exits, ${building.windows?.length ?? 0} windows, ${building.spawn_zones.length} spawn zones, ${building.obstructions.length} obstructions. ${selections.length > 1 ? `${selections.length} selected objects. ` : selectedElement && selected ? `Selected: ${objectName(building, selected)}. ` : ""}Use layout tools to draw or the element inspector to edit.`}
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
                  if (target && tool !== "wall-freehand") {
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
                onLostPointerCapture={() =>
                  setGesture((g) => (g?.curve && g.tracing ? g : null))
                }
                onPointerLeave={() => setCursor(null)}
                onKeyDown={(event) => {
                  if (disabled) return;
                  if (event.key === "Escape") {
                    setGesture(null);
                    if (propertiesOpen) closeProperties();
                    else if (!gesture) selectElement(null);
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
                  {building.windows?.length ?? 0} windows ·{" "}
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
                    "windows",
                    "spawn_zones",
                    "obstructions",
                    "stair_areas",
                    "tornado_zones",
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
                            true,
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
                            true,
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
                {(selected.kind === "doors" || selected.kind === "exits") && (
                  <>
                    <label className="block-toggle">
                      <input
                        type="checkbox"
                        aria-describedby="opening-block-help"
                        checked={openingStartsBlocked(building, selected.id)}
                        onChange={(event) =>
                          commit(
                            setOpeningBlocked(
                              building,
                              selected.kind === "doors" ? "doors" : "exits",
                              selected.id,
                              event.target.checked,
                            ),
                          )
                        }
                      />
                      Blocked
                    </label>
                    <p className="note" id="opening-block-help">
                      Initial state for the next simulation run. Later scheduled
                      changes are preserved. Physical barriers still apply.
                    </p>
                  </>
                )}
                {selected.kind === "obstructions" && (
                  <>
                    <label className="number-field">
                      Drawing style
                      <select
                        aria-label="Object drawing style"
                        value={furnitureSymbols.get(selected.id) ?? ""}
                        onChange={(event) =>
                          changeFurnitureStyle(
                            event.target.value as FurnitureKind | "",
                          )
                        }
                      >
                        <option value="">Plain object</option>
                        {Object.entries(furniturePresets).map(
                          ([kind, preset]) => (
                            <option key={kind} value={kind}>
                              {preset.label}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <p className="note">
                      All styles, including Chair, block the full rectangle.
                      JSON saves names and geometry. Styles support Undo/Redo
                      but last only this session; import/reload restores plain
                      objects.
                    </p>
                  </>
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
                    ? `On ${objectName(building, { kind: "walls", id: selectedElement.wall_id })}. ${selected.kind === "windows" ? "Windows stay distinct and solid until serviced by the engine." : "Touching openings merge only with matching blocked states and compatible schedules. Blocked openings stay solid."}`
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
                {selected.kind === "windows" && (
                  <WindowProperties
                    building={building}
                    window={building.windows!.find(
                      (w) => w.id === selected.id,
                    )!}
                    onChange={commit}
                  />
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
                Select an object. Export JSON to save your layout.
              </p>
            )}
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
    </section>
  );
}
