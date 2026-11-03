import { formatDimensions, formatLength } from "../utils/units";

import { isSpawnZone, spawnRing } from "./spawnGeometry";
import type { SpawnZone } from "../types/simulation";
import { drawStalker } from "./drawPursuit";
import type { Point, WindowFrameState } from "../types/simulation";
import { DEFAULT_SHELTER_CAPACITY } from "../types/simulation";
import {
  canvasView,
  openingSegment,
  type Selection,
  type CanvasCamera,
} from "./geometry";
import { drawGrid } from "./drawGrid";
import type { DraftingPreferences } from "./drafting";
import type { WallSnapTarget } from "./snapping";
import { wallLengthLabels, type MeasurementVisibility } from "./measurements";
import {
  solidWallSegments,
  openingLabels,
  type OpeningLayout,
} from "./openings";
import { openingStartsBlocked } from "./openingState";
import { doorLeaves } from "./doorSymbols";
import { drawFurniture, type FurnitureKind } from "./furniture";
import { dragRectangle, wallShapePoints } from "./shapes";
import { isWallTool, type EditorTool } from "./tools";
import { canvasPalette, type CanvasPalette } from "../styles/canvasPalette";

function traceSpawn(ctx: CanvasRenderingContext2D, zone: SpawnZone) {
  ctx.beginPath();
  for (const ring of [spawnRing(zone), ...(zone.holes ?? [])]) {
    ctx.moveTo(ring[0]!.x, ring[0]!.y);
    for (const p of ring.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
  }
}

export function drawLayout(
  canvas: HTMLCanvasElement,
  building: OpeningLayout,
  selected: Selection | readonly Selection[] | null,
  draft?: {
    start: Point;
    end: Point;
    /** Raw pointer position, before optional endpoint/grid snapping. */
    pointer?: Point;
    shape: EditorTool | "marquee";
    constrain?: boolean;
    points?: readonly Point[];
    invalid?: boolean;
  },
  pixelRatio = 1,
  palette: CanvasPalette = canvasPalette(canvas),
  options?: {
    camera?: CanvasCamera;
    grid?: DraftingPreferences;
    furniture?: ReadonlyMap<string, FurnitureKind>;
    underlay?: (ctx: CanvasRenderingContext2D) => void;
    showDimensions?: boolean;
    showLabels?: boolean;
    showPursuitStart?: boolean;
    windowStates?: readonly WindowFrameState[];
    disasterState?: import("../types/simulation").DisasterState;
    hazardMode?: "filled" | "outline" | "both";
    showBlockedLabels?: boolean;
    snapTarget?: WallSnapTarget | null;
    measurements?: MeasurementVisibility;
    declutterLabels?: boolean;
    hoveredId?: string;
    showPlacedOccupants?: boolean;
  },
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const display = canvas.getBoundingClientRect();
  if (display.width <= 0 || display.height <= 0) return;
  const ratio = Number.isFinite(pixelRatio) ? Math.max(1, pixelRatio) : 1;
  const width = Math.max(1, Math.round(display.width * ratio));
  const height = Math.max(1, Math.round(display.height * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const { scale, x, y } = canvasView(
    canvas.width,
    canvas.height,
    building,
    options?.camera,
    ratio,
  );
  const px = ratio / scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, x, y);
  ctx.fillStyle = palette.surface;
  ctx.fillRect(0, 0, building.width, building.height);
  // Traffic overlays cover spawn fills; their outlines and labels stay legible.
  if (options?.underlay) {
    ctx.fillStyle = palette.spawn;
    for (const zone of building.spawn_zones)
      if (zone.polygon) {
        traceSpawn(ctx, zone);
        ctx.fill("evenodd");
      } else ctx.fillRect(zone.x, zone.y, zone.width, zone.height);
  }
  options?.underlay?.(ctx);
  if (building.pursuit && options?.showPursuitStart !== false) {
    drawStalker(
      ctx,
      building.pursuit.stalker_start,
      Math.max(building.agent_radius, 10 * px),
    );
    if (options?.showLabels !== false) {
      ctx.fillStyle = palette.wall;
      ctx.font = `${11 * px}px system-ui`;
      ctx.fillText(
        "Stalker start",
        building.pursuit.stalker_start.x + 14 * px,
        building.pursuit.stalker_start.y,
      );
    }
  }
  if (options?.grid)
    drawGrid(
      ctx,
      building,
      { scale, x, y },
      ratio,
      options.grid,
      palette,
      !!options.camera,
    );
  ctx.lineCap = "round";
  const selections: readonly Selection[] = selected
    ? Array.isArray(selected)
      ? selected
      : [selected as Selection]
    : [];
  const selectedIds = new Set(selections.map((s) => s.id));
  const labelFocus = new Set(selectedIds);
  if (options?.hoveredId) labelFocus.add(options.hoveredId);
  const single = selections.length === 1 ? selections[0] : null;
  for (const rectangle of [
    ...building.spawn_zones,
    ...building.obstructions,
    ...(building.stair_areas ?? []),
    ...(building.tornado_zones ?? []),
  ]) {
    const spawn = "count" in rectangle;
    const shelter = building.tornado_zones?.find((a) => a.id === rectangle.id);
    const stair = building.stair_areas?.some((a) => a.id === rectangle.id);
    ctx.fillStyle = shelter
      ? "#287c6840"
      : spawn || stair
        ? palette.spawn
        : palette.obstacle;
    ctx.strokeStyle = selectedIds.has(rectangle.id)
      ? palette.selection
      : stair
        ? palette.shelter
        : spawn
          ? palette.spawnBorder
          : palette.obstacleBorder;
    ctx.lineWidth = (selectedIds.has(rectangle.id) ? 2 : 1) * px;
    if (isSpawnZone(rectangle) && rectangle.polygon) {
      traceSpawn(ctx, rectangle);
      if (!options?.underlay) ctx.fill("evenodd");
      ctx.stroke();
    } else {
      if (!spawn || !options?.underlay)
        ctx.fillRect(
          rectangle.x,
          rectangle.y,
          rectangle.width,
          rectangle.height,
        );
      ctx.strokeRect(
        rectangle.x,
        rectangle.y,
        rectangle.width,
        rectangle.height,
      );
    }
    const furniture = options?.furniture?.get(rectangle.id);
    if (furniture) {
      drawFurniture(ctx, furniture, rectangle, px);
      continue;
    }
    if (!spawn && !stair && !shelter && palette.blueprint === "1") {
      // Unclassified imported blockers retain an honest technical footprint.
      const inset = Math.min(0.08, rectangle.width / 5, rectangle.height / 5);
      ctx.lineWidth = px;
      ctx.strokeRect(
        rectangle.x + inset,
        rectangle.y + inset,
        rectangle.width - 2 * inset,
        rectangle.height - 2 * inset,
      );
      continue;
    }
    if (stair) {
      const angle =
        "orientation_degrees" in rectangle
          ? (rectangle.orientation_degrees ?? 0)
          : 0;
      const at = (u: number, v: number) => {
        const [a, b] =
          angle === 90
            ? [1 - v, u]
            : angle === 180
              ? [1 - u, 1 - v]
              : angle === 270
                ? [v, 1 - u]
                : [u, v];
        return {
          x: rectangle.x + a! * rectangle.width,
          y: rectangle.y + b! * rectangle.height,
        };
      };
      ctx.strokeStyle = selectedIds.has(rectangle.id)
        ? palette.selection
        : palette.shelter;
      ctx.lineWidth = px;
      ctx.beginPath();
      for (let i = 1; i <= 7; i++) {
        const a = at(0.12, i / 9),
          b = at(0.88, i / 9);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      const arrow = [
        at(0.5, 0.87),
        at(0.5, 0.12),
        at(0.4, 0.24),
        at(0.5, 0.12),
        at(0.6, 0.24),
      ];
      ctx.moveTo(arrow[0]!.x, arrow[0]!.y);
      for (const p of arrow.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      continue;
    }
    if (
      options?.showLabels !== false &&
      (!options?.declutterLabels ||
        labelFocus.has(rectangle.id) ||
        (rectangle.width / px >= 96 && rectangle.height / px >= 30))
    ) {
      ctx.fillStyle = spawn ? palette.wall : palette.obstacleText;
      ctx.font = `${12 * px}px system-ui`;
      ctx.fillText(
        spawn
          ? `${rectangle.count} ${rectangle.count === 1 ? "occupant" : "occupants"}`
          : shelter
            ? `${rectangle.name ?? "Tornado zone"} · Max ${shelter.max_occupants ?? DEFAULT_SHELTER_CAPACITY}`
            : "Obstruction",
        rectangle.x + 6 * px,
        rectangle.y + 17 * px,
        Math.max(rectangle.width - 8 * px, px),
      );
    }
  }
  // Hazards cover all spawn fills. Union each layer once so overlapping patches do not stack opacity.
  if (building.disaster) {
    const kind = options?.disasterState?.kind ?? building.disaster.kind;
    const color =
      kind === "fire" ? "#f47b39" : kind === "gas_leak" ? "#9abf3f" : "#a58bd4";
    const areas = options?.disasterState?.areas ?? [
      { center: building.disaster.center, radius: building.disaster.radius },
    ];
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, building.width, building.height);
    ctx.clip();
    const layer = (multiplier: number, alpha: string) => {
      ctx.beginPath();
      for (const area of areas) {
        const r = area.radius * multiplier;
        ctx.moveTo(area.center.x + r, area.center.y);
        ctx.arc(area.center.x, area.center.y, r, 0, Math.PI * 2);
      }
      ctx.fillStyle = color + alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * px;
      if (options?.hazardMode !== "outline") ctx.fill();
      if (options?.hazardMode !== "filled") ctx.stroke();
    };
    layer(kind === "fire" ? 1.6 : kind === "gas_leak" ? 2 : 1.3, "24");
    layer(1, "60");
    const first = areas[0];
    if (first && options?.showLabels !== false) {
      ctx.fillStyle = palette.wall;
      ctx.font = `${12 * px}px system-ui`;
      ctx.fillText(
        kind === "fire" ? "FIRE" : kind === "gas_leak" ? "GAS LEAK" : "TORNADO",
        first.center.x + 5 * px,
        first.center.y - 5 * px,
      );
    }
    ctx.restore();
  }
  ctx.lineCap = "round";
  if (options?.showPlacedOccupants !== false) {
    for (const [index, occupant] of (
      building.placed_occupants ?? []
    ).entries()) {
      ctx.beginPath();
      ctx.arc(occupant.x, occupant.y, building.agent_radius, 0, Math.PI * 2);
      ctx.fillStyle = palette.selection;
      ctx.fill();
      ctx.strokeStyle = selectedIds.has(occupant.id)
        ? palette.wall
        : palette.background;
      ctx.lineWidth = selectedIds.has(occupant.id) ? 2 * px : px;
      ctx.stroke();
      if (selectedIds.has(occupant.id)) {
        ctx.beginPath();
        ctx.arc(
          occupant.x,
          occupant.y,
          building.agent_radius + 3 * px,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
        ctx.font = `${11 * px}px system-ui`;
        ctx.fillStyle = palette.wall;
        ctx.fillText(
          occupant.name ?? `Occupant ${index + 1}`,
          occupant.x + building.agent_radius + 6 * px,
          occupant.y - 6 * px,
        );
      }
    }
  }
  for (const wall of building.walls) {
    for (const [start, end] of solidWallSegments(
      building,
      wall,
      options?.windowStates,
    )) {
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      if (selectedIds.has(wall.id)) {
        ctx.lineWidth = wall.thickness + 6 * px;
        ctx.strokeStyle = palette.selection;
        ctx.stroke();
      }
      ctx.lineWidth = wall.thickness;
      ctx.strokeStyle = palette.wall;
      ctx.stroke();
      if (palette.blueprint === "1" && wall.thickness > 2 * px) {
        ctx.lineWidth = wall.thickness - 2 * px;
        ctx.strokeStyle = palette.surface;
        ctx.stroke();
      }
    }
  }
  for (const [openings, color] of [
    [building.doors, palette.door],
    [building.exits, palette.exit],
  ] as const) {
    for (const opening of openings) {
      const wall = building.walls.find((v) => v.id === opening.wall_id);
      if (!wall) continue;
      const [a, b] = openingSegment(opening, wall);
      const blocked =
        openingStartsBlocked(building, opening.id) ||
        (building.closedDoorIds?.includes(opening.id) ?? false);
      const blueprintDoor =
        palette.blueprint === "1" && openings === building.doors && !blocked;
      ctx.lineCap = "butt";
      ctx.lineWidth = selectedIds.has(opening.id) ? 5 * px : 3 * px;
      ctx.strokeStyle =
        blueprintDoor && selectedIds.has(opening.id)
          ? palette.selection
          : blocked
            ? palette.danger
            : color;
      if (!blueprintDoor) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      if (blocked) {
        // A persistent cross marks closure even when drafting labels are hidden.
        const length = Math.hypot(b.x - a.x, b.y - a.y),
          tx = (b.x - a.x) / length,
          ty = (b.y - a.y) / length,
          size = Math.min(opening.width / 4, 6 * px),
          cx = (a.x + b.x) / 2,
          cy = (a.y + b.y) / 2;
        ctx.lineWidth = 2 * px;
        ctx.beginPath();
        for (const side of [-1, 1]) {
          ctx.moveTo(
            cx - tx * size - ty * size * side,
            cy - ty * size + tx * size * side,
          );
          ctx.lineTo(
            cx + tx * size + ty * size * side,
            cy + ty * size - tx * size * side,
          );
        }
        ctx.stroke();
      }
      if (blueprintDoor) {
        const angle = Math.atan2(b.y - a.y, b.x - a.x),
          normal = { x: -Math.sin(angle), y: Math.cos(angle) };
        ctx.lineWidth = selectedIds.has(opening.id) ? 2 * px : px;
        ctx.beginPath();
        for (const jamb of [a, b]) {
          ctx.moveTo(
            jamb.x - (normal.x * wall.thickness) / 2,
            jamb.y - (normal.y * wall.thickness) / 2,
          );
          ctx.lineTo(
            jamb.x + (normal.x * wall.thickness) / 2,
            jamb.y + (normal.y * wall.thickness) / 2,
          );
        }
        ctx.stroke();
        for (const leaf of doorLeaves(opening, wall)) {
          ctx.beginPath();
          ctx.moveTo(leaf.hinge.x, leaf.hinge.y);
          ctx.lineTo(leaf.tip.x, leaf.tip.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(
            leaf.hinge.x,
            leaf.hinge.y,
            leaf.radius,
            leaf.startAngle,
            leaf.endAngle,
            leaf.counterclockwise,
          );
          ctx.stroke();
        }
      }
      ctx.lineCap = "round";
    }
  }
  // Glazing has a double-line symbol; only recorded engine state reveals an aperture.
  for (const pane of building.windows ?? []) {
    const wall = building.walls.find((w) => w.id === pane.wall_id);
    if (!wall) continue;
    const [a, b] = openingSegment(pane, wall),
      length = Math.hypot(b.x - a.x, b.y - a.y);
    const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
    const state =
      options?.windowStates?.find((s) => s.window_id === pane.id)?.state ??
      "intact";
    const clear = state === "open" || state === "broken";
    ctx.strokeStyle = selectedIds.has(pane.id)
      ? palette.selection
      : clear
        ? state === "broken"
          ? palette.danger
          : palette.exit
        : state === "intact"
          ? palette.muted
          : palette.door;
    ctx.lineWidth = (selectedIds.has(pane.id) ? 2 : 1) * px;
    ctx.lineCap = "butt";
    ctx.beginPath();
    for (const side of [-1, 1]) {
      const inset = normal.x * side * Math.max(wall.thickness / 2, 3 * px),
        dy = normal.y * side * Math.max(wall.thickness / 2, 3 * px);
      ctx.moveTo(a.x + inset, a.y + dy);
      ctx.lineTo(b.x + inset, b.y + dy);
    }
    if (!clear) {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    for (const p of [a, b]) {
      ctx.moveTo(
        p.x - normal.x * wall.thickness,
        p.y - normal.y * wall.thickness,
      );
      ctx.lineTo(
        p.x + normal.x * wall.thickness,
        p.y + normal.y * wall.thickness,
      );
    }
    ctx.stroke();
    if (
      single?.kind === "windows" &&
      single.id === pane.id &&
      pane.emergency_escape
    ) {
      const side = pane.emergency_escape.exterior_side,
        direction = { x: normal.x * side, y: normal.y * side },
        center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        tip = {
          x: center.x + direction.x * 25 * px,
          y: center.y + direction.y * 25 * px,
        };
      ctx.strokeStyle = palette.selection;
      ctx.beginPath();
      ctx.moveTo(center.x, center.y);
      ctx.lineTo(tip.x, tip.y);
      for (const sign of [-1, 1]) {
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(
          tip.x - direction.x * 7 * px + direction.y * sign * 4 * px,
          tip.y - direction.y * 7 * px - direction.x * sign * 4 * px,
        );
      }
      ctx.stroke();
    }
  }
  ctx.font = `${11 * px}px system-ui`;
  const openingAnnotations =
    options?.showLabels === false && !options.measurements
      ? []
      : openingLabels(
          building,
          px,
          (text) => ctx.measureText?.(text).width ?? text.length * 6 * px,
          options?.windowStates,
          options?.measurements || options?.declutterLabels
            ? {
                measurements: options.measurements ?? {
                  walls: false,
                  doors: true,
                  windows: true,
                  exits: true,
                },
                showNames: options.showLabels !== false,
                declutter: options.declutterLabels,
                focusIds: labelFocus,
              }
            : undefined,
        );
  for (const label of openingAnnotations) {
    if (
      options?.showBlockedLabels === false &&
      openingStartsBlocked(building, label.id) &&
      !selectedIds.has(label.id)
    )
      continue;
    ctx.fillStyle = building.windows?.some((w) => w.id === label.id)
      ? palette.muted
      : openingStartsBlocked(building, label.id) ||
          building.closedDoorIds?.includes(label.id)
        ? palette.danger
        : building.exits.some((o) => o.id === label.id)
          ? palette.exit
          : palette.door;
    ctx.fillText(label.text, label.x, label.y);
  }
  if (options?.measurements?.walls) {
    ctx.fillStyle = palette.wall;
    for (const label of wallLengthLabels(
      options.declutterLabels
        ? {
            ...building,
            walls: building.walls.filter(
              (wall) =>
                labelFocus.has(wall.id) ||
                Math.hypot(
                  wall.end.x - wall.start.x,
                  wall.end.y - wall.start.y,
                ) /
                  px >=
                  96,
            ),
          }
        : building,
      px,
      (text) => ctx.measureText(text).width,
      openingAnnotations,
    ))
      ctx.fillText(label.text, label.x, label.y);
  }
  if (single?.kind === "walls") {
    const wall = building.walls.find((v) => v.id === single.id);
    if (wall)
      for (const point of [wall.start, wall.end]) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5 * px, 0, Math.PI * 2);
        ctx.fillStyle = palette.surface;
        ctx.strokeStyle = palette.selection;
        ctx.lineWidth = 2 * px;
        ctx.fill();
        ctx.stroke();
      }
  }
  if (draft) {
    ctx.strokeStyle = draft.invalid ? palette.danger : palette.selection;
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    if (draft.shape === "marquee" || draft.shape === "spawn") {
      const r = dragRectangle(
        draft.start,
        draft.end,
        building,
        draft.shape === "spawn" && !!draft.constrain,
      );
      ctx.globalAlpha = draft.shape === "spawn" ? 0.22 : 0.1;
      ctx.fillStyle = draft.invalid ? palette.danger : palette.selection;
      ctx.fillRect(r.x, r.y, r.width, r.height);
      ctx.globalAlpha = 1;
      ctx.strokeRect(r.x, r.y, r.width, r.height);
    } else if (draft.shape === "spawn-polygon" && draft.points?.length) {
      ctx.beginPath();
      ctx.moveTo(draft.points[0]!.x, draft.points[0]!.y);
      for (const p of draft.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.lineTo(draft.end.x, draft.end.y);
      ctx.closePath();
      ctx.fillStyle = palette.spawn;
      ctx.fill();
      ctx.stroke();
      for (const p of draft.points) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 * px, 0, Math.PI * 2);
        ctx.fillStyle = palette.selection;
        ctx.fill();
      }
    } else if (draft.shape === "wall-freehand") {
      ctx.setLineDash([]);
      ctx.lineWidth = 0.2;
      ctx.globalAlpha = 0.65;
      if (draft.points?.length) {
        ctx.beginPath();
        ctx.moveTo(draft.points[0]!.x, draft.points[0]!.y);
        for (const p of draft.points.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (isWallTool(draft.shape)) {
      const points = wallShapePoints(
        draft.shape,
        draft.start,
        draft.end,
        building,
        draft.constrain,
      );
      ctx.beginPath();
      ctx.moveTo(points[0]!.x, points[0]!.y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    } else {
      const r = dragRectangle(
        draft.start,
        draft.end,
        building,
        !!draft.constrain,
      );
      ctx.strokeRect(r.x, r.y, r.width, r.height);
    }
    ctx.setLineDash([]);
  }
  if (building.disaster) {
    const center =
      options?.disasterState?.kind === "tornado"
        ? (options.disasterState.areas[0]?.center ?? building.disaster.center)
        : building.disaster.center;
    ctx.save();
    ctx.fillStyle = palette.surface;
    ctx.strokeStyle = palette.wall;
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.arc(center.x, center.y, 6 * px, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(center.x - 9 * px, center.y);
    ctx.lineTo(center.x + 9 * px, center.y);
    ctx.moveTo(center.x, center.y - 9 * px);
    ctx.lineTo(center.x, center.y + 9 * px);
    ctx.stroke();
    ctx.restore();
  }
  if (options?.showDimensions !== false) {
    ctx.fillStyle = palette.muted;
    ctx.font = `${12 * px}px system-ui`;
    ctx.fillText(
      formatDimensions(building.width, building.height),
      12 * px,
      20 * px,
    );
  }
  if (options?.snapTarget) {
    const { point } = options.snapTarget;
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = palette.selection;
    ctx.fillStyle = palette.surface;
    ctx.lineWidth = 2 * px;
    ctx.fillRect(point.x - 5 * px, point.y - 5 * px, 10 * px, 10 * px);
    ctx.strokeRect(point.x - 5 * px, point.y - 5 * px, 10 * px, 10 * px);
    ctx.beginPath();
    ctx.moveTo(point.x - 9 * px, point.y);
    ctx.lineTo(point.x + 9 * px, point.y);
    ctx.moveTo(point.x, point.y - 9 * px);
    ctx.lineTo(point.x, point.y + 9 * px);
    ctx.stroke();
    ctx.restore();
  }
  if (draft?.shape === "wall") {
    const dx = draft.end.x - draft.start.x;
    const dy = draft.end.y - draft.start.y;
    const length = Math.hypot(dx, dy);
    if (length > 0 && Number.isFinite(length)) {
      // Display-only annotation in CSS pixels: zoom and DPI do not enlarge it.
      ctx.save();
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.font = "500 12px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const text = formatLength(length, 2);
      const halfWidth = (ctx.measureText(text).width + 12) / 2;
      const halfHeight = 11;
      const screen = (point: Point) => ({
        x: (x + point.x * scale) / ratio,
        y: (y + point.y * scale) / ratio,
      });
      const middle = screen({
        x: (draft.start.x + draft.end.x) / 2,
        y: (draft.start.y + draft.end.y) / 2,
      });
      const pointer = screen(draft.pointer ?? draft.end);
      let nx = -dy / length,
        ny = dx / length;
      if (ny > 0 || (ny === 0 && nx < 0)) {
        nx = -nx;
        ny = -ny;
      }
      const offset = Math.abs(nx) * halfWidth + Math.abs(ny) * halfHeight + 16;
      const candidates = [
        { x: middle.x + nx * offset, y: middle.y + ny * offset },
        { x: middle.x - nx * offset, y: middle.y - ny * offset },
        { x: pointer.x, y: pointer.y - halfHeight - 24 },
        { x: pointer.x, y: pointer.y + halfHeight + 24 },
        { x: pointer.x + halfWidth + 24, y: pointer.y },
        { x: pointer.x - halfWidth - 24, y: pointer.y },
      ].map((desired) => {
        const position = {
          x: Math.max(
            halfWidth + 8,
            Math.min(canvas.width / ratio - halfWidth - 8, desired.x),
          ),
          y: Math.max(
            halfHeight + 8,
            Math.min(canvas.height / ratio - halfHeight - 8, desired.y),
          ),
        };
        return {
          ...position,
          clearance: Math.hypot(
            Math.max(Math.abs(pointer.x - position.x) - halfWidth, 0),
            Math.max(Math.abs(pointer.y - position.y) - halfHeight, 0),
          ),
          shift: (position.x - desired.x) ** 2 + (position.y - desired.y) ** 2,
        };
      });
      const position = candidates
        .filter((p) => p.clearance >= 12)
        .sort((a, b) => a.shift - b.shift)[0];
      // A tiny or fully obscured viewport may have no safe label placement.
      if (position) {
        ctx.fillStyle = palette.surface;
        ctx.strokeStyle = palette.selection;
        ctx.lineWidth = 1;
        ctx.fillRect(
          position.x - halfWidth,
          position.y - halfHeight,
          halfWidth * 2,
          halfHeight * 2,
        );
        ctx.strokeRect(
          position.x - halfWidth,
          position.y - halfHeight,
          halfWidth * 2,
          halfHeight * 2,
        );
        ctx.fillStyle = palette.wall;
        ctx.fillText(text, position.x, position.y);
      }
      ctx.restore();
    }
  }
}
