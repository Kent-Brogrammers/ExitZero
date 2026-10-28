import {
  formatLength,
  formatDimensions,
  lengthInputValue,
  lengthFromInput,
} from "../utils/units";
import DxfImport from "./dxf/DxfImport";
import type { LayoutSaveActions } from "../templates/layouts";
import { DisasterControls } from "./DisasterControls";
import {
  addFurniture,
  furnitureKind,
  furniturePresets,
  type FurnitureKind,
} from "./furniture";
import { configureWindowEscape, hitOpening } from "./openings";
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
  useMemo,
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
import { RoomFillDialog } from "./RoomFillDialog";
import {
  detectRoom,
  populateRoom,
  resizeRoomPopulation,
  roomFillZones,
  type Room,
} from "./roomFill";
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
  type CanvasCamera,
} from "./geometry";
import {
  combineSelection,
  marqueeSelection,
  selectionBounds,
  moveSelection,
  removeSelection,
  resizeSelection,
  canResizeSelection,
  rotateObstruction,
} from "./selection";
import { drawLayout } from "./draw";
import { nearestWallSnap, wallSnapTargets } from "./snapping";
import { measurementVisibility } from "./measurements";
import { constrainWallEnd, isOnLockedWallAngle } from "./wallAngles";
import "./BuildingEditor.css";

type EditorSnapshot = {
  building: BuildingScenario;
  furniture: Map<string, FurnitureKind>;
};

type Gesture = {
  start: Point;
  current: Point;
  rawCurrent?: Point;
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
  onSaved?: (building: BuildingScenario, reason?: "export" | "replace") => void;
  saveActions?: LayoutSaveActions;
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
  const displayed = integer ? value : lengthInputValue(value);
  return (
    <label className="number-field">
      {label}
      {integer ? "" : " (ft)"}
      <input
        key={value}
        type="number"
        step={integer ? 1 : "any"}
        defaultValue={displayed}
        onBlur={(event) => {
          const input = event.currentTarget.valueAsNumber;
          const next = integer ? input : lengthFromInput(input, value);
          if (Number.isFinite(next) && next !== value) onCommit(next);
          event.currentTarget.value = String(displayed);
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
  saveActions,
  editorRef,
}: BuildingEditorProps) {
  const theme = useStudioTheme();
  const [drafting, setDrafting] = useDraftingPreferences();
  const editor = useRef<HTMLElement>(null);
  const [expandedView, setExpandedView] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [camera, setCamera] = useState<CanvasCamera>({
    zoom: 1,
    pan: { x: 0, y: 0 },
    extent: { width: building.width, height: building.height },
  });
  const [panMode, setPanMode] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const panGesture = useRef<{
    id: number;
    x: number;
    y: number;
    pan: Point;
  } | null>(null);
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
  const [roomDraft, setRoomDraft] = useState<Room | null>(null);
  const [roomCount, setRoomCount] = useState(10);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<EditorSnapshot[]>([]);
  const [redo, setRedo] = useState<EditorSnapshot[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const snapTargets = useMemo(
    () => wallSnapTargets(building.walls),
    [building.walls],
  );
  const selectedElement = selected
    ? (building[selected.kind] ?? []).find((v) => v.id === selected.id)
    : null;
  const selectedRoomZones =
    selected?.kind === "spawn_zones"
      ? roomFillZones(building, selected.id)
      : [];

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
    setCursor(null);
    setPanMode(false);
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
      camera,
      window.devicePixelRatio,
    );
    return {
      x: clamp(
        (((event.clientX - rect.left) / rect.width) *
          event.currentTarget.width -
          view.x) /
          view.scale,
        0,
        1000,
      ),
      y: clamp(
        (((event.clientY - rect.top) / rect.height) *
          event.currentTarget.height -
          view.y) /
          view.scale,
        0,
        1000,
      ),
    };
  }
  function tolerance() {
    const target = canvas.current;
    if (!target) return 0.3;
    return (
      (12 * target.width) /
      target.getBoundingClientRect().width /
      canvasView(
        target.width,
        target.height,
        building,
        camera,
        window.devicePixelRatio,
      ).scale
    );
  }
  function zoomAt(factor: number, client?: Point) {
    const element = canvas.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setCamera((previous) => {
      const zoom = clamp(previous.zoom * factor, 0.1, 20);
      const relative = zoom / previous.zoom;
      const anchor = client
        ? {
            x: client.x - rect.left - rect.width / 2,
            y: client.y - rect.top - rect.height / 2,
          }
        : { x: 0, y: 0 };
      return {
        ...previous,
        zoom,
        pan: {
          x: anchor.x - (anchor.x - previous.pan.x) * relative,
          y: anchor.y - (anchor.y - previous.pan.y) * relative,
        },
      };
    });
  }
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (panGesture.current) return;
      // Keep an unfinished drawing anchored while navigating.
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element.clientHeight
            : 1);
      zoomAt(Math.exp(-clamp(delta, -300, 300) * 0.002), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    const releaseSpace = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceDown(false);
    };
    const blur = () => {
      setSpaceDown(false);
      panGesture.current = null;
      setPanning(false);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keyup", releaseSpace);
    window.addEventListener("blur", blur);
    return () => {
      element.removeEventListener("wheel", wheel);
      window.removeEventListener("keyup", releaseSpace);
      window.removeEventListener("blur", blur);
    };
  }, []);
  function fitPlan() {
    setCamera({
      zoom: 1,
      pan: { x: 0, y: 0 },
      extent: { width: building.width, height: building.height },
    });
  }
  function extendForPoints(
    base: BuildingScenario,
    ...points: Point[]
  ): BuildingScenario {
    const width = Math.min(
      1000,
      Math.max(
        base.width,
        ...points.map((p) => (p.x > base.width ? p.x + 1 : base.width)),
      ),
    );
    const height = Math.min(
      1000,
      Math.max(
        base.height,
        ...points.map((p) => (p.y > base.height ? p.y + 1 : base.height)),
      ),
    );
    return width === base.width && height === base.height
      ? base
      : { ...base, width, height };
  }
  function gridPoint(point: Point): Point {
    if (drafting.snap)
      return snapGridPoint(point, gridSpacings[drafting.spacing].metres, {
        width: 1000,
        height: 1000,
      });
    return point;
  }
  function wallTarget(point: Point, excludedWallId?: string) {
    return drafting.snapEndpoints !== false
      ? nearestWallSnap(point, snapTargets, tolerance(), excludedWallId)
      : null;
  }
  function snap(point: Point, excludedWallId?: string): Point {
    const target = wallTarget(point, excludedWallId);
    return target ? { ...target.point } : gridPoint(point);
  }
  function wallEnd(start: Point, pointer: Point, locked = false) {
    if (!locked) return { point: snap(pointer), target: wallTarget(pointer) };
    const target =
      drafting.snapEndpoints !== false
        ? nearestWallSnap(
            pointer,
            snapTargets,
            tolerance(),
            undefined,
            (candidate) => isOnLockedWallAngle(start, pointer, candidate.point),
          )
        : null;
    return {
      point: target
        ? { ...target.point }
        : constrainWallEnd(
            start,
            pointer,
            { width: 1000, height: 1000 },
            drafting.snap ? gridSpacings[drafting.spacing].metres : undefined,
          ),
      target,
    };
  }
  function setWallAngleLock(locked: boolean) {
    if (disabled || tool !== "wall") return;
    setGesture((g) =>
      g && !g.selection && !g.hazard && !g.marquee
        ? {
            ...g,
            constrain: locked,
            current: wallEnd(g.start, g.rawCurrent ?? g.current, locked).point,
          }
        : g,
    );
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
      const next = structuredClone(extendForPoints(g.base, g.current));
      next.walls.find((w) => w.id === g.selection!.id)![g.endpoint] = snap(
        g.current,
        g.selection.id,
      );
      return { building: next, snapped: false };
    }
    let delta = { x: g.current.x - g.start.x, y: g.current.y - g.start.y };
    const bounds = selectionBounds(g.base, g.items ?? [g.selection]);
    const base = bounds
      ? extendForPoints(g.base, {
          x: bounds.x + bounds.width + delta.x,
          y: bounds.y + bounds.height + delta.y,
        })
      : g.base;
    const items = g.items ?? [g.selection];
    if (
      drafting.snap &&
      items.length === 1 &&
      (g.selection.kind === "doors" || g.selection.kind === "exits")
    ) {
      const snapped = snapOpeningToNeighbor(
        moveSelection(base, items, delta),
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
          { width: 1000, height: 1000 },
        );
        delta = { x: p.x - bounds.x, y: p.y - bounds.y };
      }
    }
    return { building: moveSelection(base, items, delta), snapped: false };
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
    const width = Math.min(
      kind === "windows"
        ? Math.max(
            1.2,
            2 * building.agent_radius + closest.wall.thickness + 0.05,
          )
        : 1.2,
      wallLength(closest.wall),
    );
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
    const candidate =
      kind === "windows"
        ? configureWindowEscape(building, opening)
        : {
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
    const endpoint = drafting.snap ? gridPoint(g.current) : g.current;
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
    const next = addFreehandWalls(
      extendForPoints(building, ...result.points),
      result.points,
    );
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
      x: clamp(hazard.center.x + g.current.x - g.start.x, 0, 1000),
      y: clamp(hazard.center.y + g.current.y - g.start.y, 0, 1000),
    };
    return {
      ...extendForPoints(g.base, center),
      disaster: { ...hazard, center },
    };
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
  const editedPreview = openingPreview?.error
    ? (draftEdit?.building ?? building)
    : (openingPreview?.building ?? building);
  const preview =
    gesture && !gesture.marquee
      ? extendForPoints(editedPreview, gesture.start, gesture.current)
      : editedPreview;
  const freehand = gesture?.curve ? curveDraft(gesture) : null;
  const spawnDraft =
    tool === "spawn" && gesture && !gesture.selection
      ? addSpawnZone(
          extendForPoints(gesture.base, gesture.start, gesture.current),
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
  const activeSnap =
    cursor &&
    !disabled &&
    !panMode &&
    !panning &&
    !spaceDown &&
    (tool === "wall" || (tool === "select" && gesture?.endpoint))
      ? tool === "wall" && gesture
        ? wallEnd(gesture.start, cursor, gesture.constrain).target
        : wallTarget(
            cursor,
            gesture?.endpoint ? gesture.selection?.id : undefined,
          )
      : null;
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
              pointer: cursor ?? gesture.current,
              shape: gesture.marquee ? "marquee" : tool,
              constrain: gesture.constrain,
              points: freehand?.points,
              invalid: !!spawnProblem,
            }
          : undefined,
        window.devicePixelRatio,
        undefined,
        {
          camera,
          grid: drafting,
          furniture: furnitureSymbols,
          showLabels: tool === "select" && !gesture,
          showDimensions: tool === "select" && !gesture,
          snapTarget: activeSnap,
          measurements: measurementVisibility(drafting.measurements),
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
    camera,
    activeSnap,
    cursor,
  ]);

  function pointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (
      event.button === 1 ||
      event.button === 2 ||
      (event.button === 0 && (panMode || spaceDown))
    ) {
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      panGesture.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        pan: camera.pan,
      };
      setGesture(null);
      setCursor(null);
      setPanning(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (disabled || event.button !== 0) return;
    event.currentTarget.focus({ preventScroll: true });
    const point = world(event);
    setCursor(point);
    setError("");
    setNotice("");
    if (tool === "spawn-room") {
      try {
        setRoomDraft(detectRoom(building, point));
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not find an enclosed room.",
        );
      }
      return;
    }
    if (tool === "hazard" && building.disaster) {
      commit({
        ...extendForPoints(building, point),
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
      const start = tool === "wall" ? snap(point) : gridPoint(point);
      selectElement(null);
      setGesture({
        start,
        current: start,
        rawCurrent: start,
        base: building,
        constrain: event.shiftKey,
        spawnId: tool === "spawn" ? `spawn_${crypto.randomUUID()}` : undefined,
      });
    }
  }
  function pointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const pan = panGesture.current;
    if (pan) {
      if (pan.id === event.pointerId)
        setCamera((previous) => ({
          ...previous,
          pan: {
            x: pan.pan.x + event.clientX - pan.x,
            y: pan.pan.y + event.clientY - pan.y,
          },
        }));
      return;
    }
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
          !g.selection && !g.hazard && !g.marquee
            ? tool === "wall"
              ? wallEnd(g.start, point, event.shiftKey).point
              : gridPoint(point)
            : point,
        rawCurrent: point,
        constrain: event.shiftKey,
      };
    });
  }

  function pointerUp(event: PointerEvent<HTMLCanvasElement>) {
    if (panGesture.current?.id === event.pointerId) {
      panGesture.current = null;
      setPanning(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
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
        !gesture.selection && !gesture.hazard && !gesture.marquee
          ? tool === "wall"
            ? wallEnd(gesture.start, world(event), event.shiftKey).point
            : gridPoint(world(event))
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
    const base = extendForPoints(building, g.start, g.current);
    const furniture = furnitureKind(tool);
    if (furniture) {
      const next = addFurniture(
        extendForPoints(base, {
          x: g.start.x + furniturePresets[furniture].width / 2,
          y: g.start.y + furniturePresets[furniture].height / 2,
        }),
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
    if (distance(g.start, g.current) < 0.02) {
      if (tool === "wall" && !g.selection)
        setError(
          "Wall endpoints are too close. Drag farther or turn off wall snapping in Grid & snap.",
        );
      return;
    }
    if (g.selection) {
      commit(moved(g).building, true);
      return;
    }
    if (isWallTool(tool)) {
      const next = addWallShape(
        base,
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
        ...dragRectangle(g.start, g.current, base),
      };
      if (
        commit({
          ...base,
          tornado_zones: [...(building.tornado_zones ?? []), zone],
        })
      )
        selectElement({ kind: "tornado_zones", id: zone.id });
    } else if (tool === "stairs") {
      const area = {
        id: `stairs_${crypto.randomUUID()}`,
        name: nextObjectName(building, "stair_areas"),
        ...dragRectangle(g.start, g.current, base),
        orientation_degrees: 0 as const,
      };
      if (
        commit({
          ...base,
          stair_areas: [...(building.stair_areas ?? []), area],
        })
      )
        selectElement({ kind: "stair_areas", id: area.id });
    } else if (tool === "spawn") {
      const next = addSpawnZone(
        base,
        g.start,
        g.current,
        !!g.constrain,
        g.spawnId,
      );
      const zone = next.spawn_zones.at(-1)!;
      if (commit(next)) selectElement({ kind: "spawn_zones", id: zone.id });
    } else if (tool === "object-square" || tool === "object-rectangle") {
      const next = addObject(base, g.start, g.current, !!g.constrain);
      if (commit(next))
        selectElement({
          kind: "obstructions",
          id: next.obstructions.at(-1)!.id,
        });
    }
  }
  function changeSelected(field: string, value: number) {
    if (!selected || !selectedElement) return;
    if (field === "count" && selectedRoomZones.length) {
      try {
        const edit = resizeRoomPopulation(building, selected.id, value);
        commit(edit.building, false, [
          {
            kind: "spawn_zones",
            id: edit.ids.includes(selected.id) ? selected.id : edit.ids[0]!,
          },
        ]);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not update the room population.",
        );
      }
      return;
    }
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
      onSaved?.(next, "replace");
      selectElement(null);
      setGesture(null);
      setCamera({
        zoom: 1,
        pan: { x: 0, y: 0 },
        extent: { width: next.width, height: next.height },
      });
      return true;
    }
    return false;
  }
  function exportLayout() {
    savedLayout.current = JSON.stringify(building);
    onSaved?.(building, "export");
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
      onKeyDown={(event) => {
        if (
          disabled ||
          gesture ||
          event.defaultPrevented ||
          event.repeat ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.key.toLowerCase() !== "r" ||
          selections.length !== 1 ||
          selected?.kind !== "obstructions" ||
          (event.target instanceof Element &&
            event.target.closest(
              'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], dialog',
            ))
        )
          return;
        event.preventDefault();
        const next = rotateObstruction(building, selected.id);
        if (next !== building) commit(next);
      }}
      onKeyDownCapture={(event) => {
        if (
          event.key === "Escape" &&
          expandedView &&
          !(
            event.target instanceof Element &&
            event.target.closest("dialog[open]")
          )
        ) {
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
        <span className="badge">Freeform · feet</span>
      </div>
      {roomDraft && (
        <RoomFillDialog
          initialCount={
            building.spawn_zones
              .filter((z) => roomDraft.spawnIds.includes(z.id))
              .reduce((sum, z) => sum + z.count, 0) || roomCount
          }
          existingCount={building.spawn_zones
            .filter((z) => roomDraft.spawnIds.includes(z.id))
            .reduce((sum, z) => sum + z.count, 0)}
          onClose={() => setRoomDraft(null)}
          onFill={(count) => {
            const edit = populateRoom(
              building,
              detectRoom(building, roomDraft.point),
              count,
            );
            if (
              !commit(edit.building, false, [
                { kind: "spawn_zones", id: edit.ids[0]! },
              ])
            )
              throw new Error(
                "Could not apply this room fill. Check the layout and try again.",
              );
            setRoomCount(count);
            setNotice(
              `Room filled · ${count} occupants across ${edit.ids.length} spawn areas · Edit the total in Properties`,
            );
          }}
        />
      )}
      <DxfImport
        base={building}
        disabled={disabled}
        dialogRef={dxfDialog}
        onApply={(next) => replaceLayout(next, "the reviewed DXF layout")}
      />
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
              scenarioControls={
                <DisasterControls
                  building={building}
                  onChange={(next) => {
                    const applied = commit(next);
                    if (applied && !next.disaster && tool === "hazard")
                      changeTool("select");
                    return applied;
                  }}
                  onLocate={() => changeTool("hazard")}
                />
              }
              saveActions={saveActions}
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
                    label="Width"
                    value={building.width}
                    onCommit={(width) => commit({ ...building, width })}
                  />
                  <NumberField
                    label="Height"
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
                    Up to {formatLength(1000)} per side. Existing objects keep
                    their size and position. Undo restores the previous area.
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
            {(activeSnap ||
              draftEdit?.snapped ||
              notice ||
              selections.length > 0) && (
              <p
                className="editor-selection-feedback"
                role="status"
                data-snap-target={activeSnap?.kind}
                title={selected ? objectName(building, selected) : ""}
              >
                {activeSnap
                  ? `Snap: wall ${activeSnap.kind} · ${lengthInputValue(activeSnap.point.x, 2)}, ${lengthInputValue(activeSnap.point.y, 2)} ft`
                  : draftEdit?.snapped
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
                      ? selected?.kind === "obstructions" &&
                        selections.length === 1
                        ? "R rotates the object 90° · Drag to move · Double-click for Properties"
                        : "Drag objects or a hazard’s centre marker to move or marquee select · Shift-click to add · Double-click for Properties"
                      : tool === "wall-freehand"
                        ? freehand?.error &&
                          gesture?.curve &&
                          gesture.curve.length > 1
                          ? freehand.error
                          : "Drag or click–trace–click · Escape cancels · Alt-click selects one segment"
                        : tool === "wall"
                          ? "Drag a wall · Hold Shift for horizontal, vertical or 45° · Configure snapping in Grid & snap"
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
                                  : tool === "spawn-room"
                                    ? "Click inside an enclosed room · Set its occupant count · Walls, furniture and body clearance are respected"
                                    : tool === "spawn"
                                      ? (spawnProblem ??
                                        (spawnDraft
                                          ? `${formatDimensions(spawnDraft.spawn_zones.at(-1)!.width, spawnDraft.spawn_zones.at(-1)!.height, 2)} · ${spawnDraft.spawn_zones.at(-1)!.count} occupants · Release to place`
                                          : "Drag across rooms or furniture · Agents spawn in clear space · Shift for square · Set occupants in Properties"))
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
                aria-label={`Editable floor plan, ${formatDimensions(building.width, building.height)}. ${building.walls.length} walls, ${building.doors.length} doors, ${building.exits.length} exits, ${building.windows?.length ?? 0} windows, ${building.spawn_zones.length} spawn zones, ${building.obstructions.length} obstructions. ${selections.length > 1 ? `${selections.length} selected objects. ` : selectedElement && selected ? `Selected: ${objectName(building, selected)}. ` : ""}Use layout tools to draw or the element inspector to edit.`}
                style={{
                  aspectRatio: "3 / 2",
                  cursor: panning
                    ? "grabbing"
                    : panMode || spaceDown
                      ? "grab"
                      : tool === "select"
                        ? gesture
                          ? "grabbing"
                          : "default"
                        : "crosshair",
                }}
                onContextMenu={(event) => event.preventDefault()}
                onDoubleClick={(event) => {
                  if (panMode || spaceDown) return;
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
                onPointerCancel={() => {
                  setGesture(null);
                  setCursor(null);
                  panGesture.current = null;
                  setPanning(false);
                }}
                onLostPointerCapture={() => {
                  panGesture.current = null;
                  setPanning(false);
                  setGesture((g) => (g?.curve && g.tracing ? g : null));
                }}
                onPointerLeave={() => setCursor(null)}
                onKeyUp={(event) => {
                  if (event.key === "Shift") setWallAngleLock(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Shift") setWallAngleLock(true);
                  if (event.code === "Space") {
                    event.preventDefault();
                    setSpaceDown(true);
                    return;
                  }
                  if (
                    ["+", "=", "-", "0"].includes(event.key) &&
                    !event.ctrlKey &&
                    !event.metaKey
                  ) {
                    event.preventDefault();
                    if (event.key === "0") fitPlan();
                    else zoomAt(event.key === "-" ? 1 / 1.25 : 1.25);
                    return;
                  }
                  if (disabled) return;
                  if (event.key === "Escape") {
                    setGesture(null);
                    setCursor(null);
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
              <div
                className="canvas-navigation"
                role="group"
                aria-label="Canvas navigation"
              >
                <button
                  type="button"
                  aria-label="Pan canvas"
                  aria-pressed={panMode}
                  onClick={() => {
                    setPanMode((value) => !value);
                    setGesture(null);
                  }}
                >
                  Pan
                </button>
                <button
                  type="button"
                  aria-label="Zoom out"
                  onClick={() => zoomAt(1 / 1.25)}
                >
                  −
                </button>
                <output aria-label="Canvas zoom">
                  {Math.round(camera.zoom * 100)}%
                </output>
                <button
                  type="button"
                  aria-label="Zoom in"
                  onClick={() => zoomAt(1.25)}
                >
                  +
                </button>
                <button type="button" onClick={() => fitPlan()}>
                  Fit plan
                </button>
                <span>Scroll to zoom · Space + drag to pan</span>
              </div>
              <div className="canvas-caption">
                <span>
                  {building.walls.length} walls · {building.doors.length} doors
                  · {building.exits.length} exits ·{" "}
                  {building.windows?.length ?? 0} windows ·{" "}
                  {building.spawn_zones.length} spawn zones
                </span>
                <span>
                  {cursor
                    ? `${lengthInputValue(cursor.x, 2)}, ${lengthInputValue(cursor.y, 2)} ft`
                    : drafting.snap
                      ? `Snap ${gridSpacings[drafting.spacing].label} · feet`
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
                {selectedRoomZones.length > 0 && (
                  <p className="note">
                    Room fill · {selectedRoomZones.length} clear areas. Room
                    occupants updates the whole fill; positions and sizes below
                    apply to this area.
                  </p>
                )}
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
                    : "Dimensions in feet"}
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
                          label={
                            field === "count"
                              ? selectedRoomZones.length
                                ? "Room occupants"
                                : "Occupants"
                              : field
                          }
                          value={
                            field === "count" && selectedRoomZones.length
                              ? selectedRoomZones.reduce(
                                  (sum, z) => sum + z.count,
                                  0,
                                )
                              : (
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
