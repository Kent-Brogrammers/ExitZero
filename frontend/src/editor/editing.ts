import type { BuildingScenario, Cell } from "../types/simulation";

export type EditorTool = "wall" | "walkable" | "door" | "exit" | "erase";

export interface EditResult {
  building: BuildingScenario;
  error: string | null;
}

function sameCell(a: Cell, b: Cell) {
  return a.x === b.x && a.y === b.y;
}

function inBounds(cell: Cell, width: number, height: number) {
  return (
    Number.isInteger(cell.x) &&
    Number.isInteger(cell.y) &&
    cell.x >= 0 &&
    cell.y >= 0 &&
    cell.x < width &&
    cell.y < height
  );
}

function onBoundary(cell: Cell, width: number, height: number) {
  return (
    cell.x === 0 ||
    cell.y === 0 ||
    cell.x === width - 1 ||
    cell.y === height - 1
  );
}

/** Map CSS pointer coordinates, independently of the Canvas backing resolution. */
export function pointerToCell(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  building: Pick<BuildingScenario, "width" | "height">,
): Cell | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const x = (clientX - bounds.left) / bounds.width;
  const y = (clientY - bounds.top) / bounds.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x >= 1 || y >= 1) return null;
  return {
    x: Math.floor(x * building.width),
    y: Math.floor(y * building.height),
  };
}

/** Fill skipped cells during fast pointer movement. */
export function cellsAlongStroke(from: Cell, to: Cell): Cell[] {
  const cells: Cell[] = [];
  let { x, y } = from;
  const dx = Math.abs(to.x - x);
  const dy = -Math.abs(to.y - y);
  const sx = x < to.x ? 1 : -1;
  const sy = y < to.y ? 1 : -1;
  let error = dx + dy;
  while (true) {
    cells.push({ x, y });
    if (x === to.x && y === to.y) return cells;
    const twiceError = 2 * error;
    if (twiceError >= dy) {
      error += dy;
      x += sx;
    }
    if (twiceError <= dx) {
      error += dx;
      y += sy;
    }
  }
}

export function applyCellTool(
  building: BuildingScenario,
  cell: Cell,
  tool: EditorTool,
): EditResult {
  const reject = (error: string): EditResult => ({ building, error });
  if (!inBounds(cell, building.width, building.height)) {
    return reject("Select a cell inside the building.");
  }
  const atCell = (other: Cell) => sameCell(other, cell);
  const inSpawnZone = building.spawn_zones.some(
    (zone) =>
      cell.x >= zone.x &&
      cell.y >= zone.y &&
      cell.x < zone.x + zone.width &&
      cell.y < zone.y + zone.height,
  );
  if (inSpawnZone && (tool === "wall" || tool === "exit")) {
    return reject(
      "Spawn zones are preserved. Walls and exits cannot be placed inside them.",
    );
  }
  if (tool === "exit" && !onBoundary(cell, building.width, building.height)) {
    return reject("Exits must be placed on the building boundary.");
  }
  if (
    building.blocked_cells.some(atCell) &&
    tool !== "walkable" &&
    tool !== "erase"
  ) {
    return reject(
      "This cell is blocked. Use Walkable or Erase to clear it first.",
    );
  }
  const previousExit = building.exits.find(atCell);
  if (previousExit && tool === "exit") return { building, error: null };
  if (previousExit && building.exits.length === 1) {
    return reject(
      "Keep at least one exit. Add another boundary exit before removing this one.",
    );
  }
  if (
    (tool === "wall" && building.walls.some(atCell)) ||
    (tool === "door" && building.doors.some(atCell)) ||
    ((tool === "erase" || tool === "walkable") &&
      !building.walls.some(atCell) &&
      !building.doors.some(atCell) &&
      !previousExit &&
      !building.blocked_cells.some(atCell))
  ) {
    return { building, error: null };
  }
  const walls = building.walls.filter((other) => !atCell(other));
  const doors = building.doors.filter((other) => !atCell(other));
  const exits = building.exits.filter((other) => !atCell(other));
  if (tool === "wall") walls.push({ ...cell });
  if (tool === "door") doors.push({ ...cell });
  if (tool === "exit") {
    const prefix = `exit-${cell.x}-${cell.y}`;
    let id = prefix;
    let suffix = 2;
    while (building.exits.some((exit) => exit.id === id)) {
      id = `${prefix}-${suffix++}`;
    }
    exits.push({ ...cell, id });
  }
  return {
    error: null,
    building: {
      ...building,
      walls,
      doors,
      exits,
      blocked_exit_ids: previousExit
        ? building.blocked_exit_ids.filter((id) => id !== previousExit.id)
        : building.blocked_exit_ids,
      blocked_cells:
        tool === "erase" || tool === "walkable"
          ? building.blocked_cells.filter((other) => !atCell(other))
          : building.blocked_cells,
    },
  };
}

/** Resize only when every existing cell, spawn rectangle and exit stays valid. */
export function resizeBuilding(
  building: BuildingScenario,
  width: number,
  height: number,
): EditResult {
  const reject = (error: string): EditResult => ({ building, error });
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 512 ||
    height > 512
  ) {
    return reject("Width and height must be whole numbers between 1 and 512.");
  }
  if (
    [
      ...building.walls,
      ...building.doors,
      ...building.exits,
      ...building.blocked_cells,
    ].some((cell) => !inBounds(cell, width, height)) ||
    building.spawn_zones.some(
      (zone) => zone.x + zone.width > width || zone.y + zone.height > height,
    )
  ) {
    return reject(
      "Resizing would remove existing cells or spawn zones. Clear those cells first.",
    );
  }
  if (building.exits.some((exit) => !onBoundary(exit, width, height))) {
    return reject(
      "Resizing would move an exit off the boundary. Relocate that exit first.",
    );
  }
  return { building: { ...building, width, height }, error: null };
}
