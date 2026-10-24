import type { BuildingScenario, Cell } from "../types/simulation";

/** Keep the original 24-unit cell drawing, scaled to the actual display size. */
export function drawBuilding(
  canvas: HTMLCanvasElement,
  building: BuildingScenario,
  selected: Cell | null,
  pixelRatio: number,
) {
  const context = canvas.getContext("2d");
  const displayWidth = canvas.getBoundingClientRect().width;
  if (!context || displayWidth <= 0) return;
  const cellSize = 24;
  const width = building.width * cellSize;
  const height = building.height * cellSize;
  const ratio = Number.isFinite(pixelRatio) ? Math.max(1, pixelRatio) : 1;
  canvas.width = Math.max(1, Math.round(displayWidth * ratio));
  canvas.height = Math.max(
    1,
    Math.round((displayWidth * height * ratio) / width),
  );
  context.setTransform(
    canvas.width / width,
    0,
    0,
    canvas.height / height,
    0,
    0,
  );
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#f8faf8";
  context.fillRect(0, 0, width, height);
  for (const zone of building.spawn_zones) {
    context.fillStyle = "#deece7";
    context.fillRect(
      zone.x * cellSize,
      zone.y * cellSize,
      zone.width * cellSize,
      zone.height * cellSize,
    );
    context.fillStyle = "#315d51";
    context.font = "12px system-ui";
    context.fillText(
      `${zone.count} occupants`,
      zone.x * cellSize + 6,
      zone.y * cellSize + 20,
    );
  }
  context.strokeStyle = "#e0e7e3";
  context.lineWidth = 1;
  for (let x = 0; x <= building.width; x++) {
    context.beginPath();
    context.moveTo(x * cellSize, 0);
    context.lineTo(x * cellSize, height);
    context.stroke();
  }
  for (let y = 0; y <= building.height; y++) {
    context.beginPath();
    context.moveTo(0, y * cellSize);
    context.lineTo(width, y * cellSize);
    context.stroke();
  }
  for (const [cells, color] of [
    [building.walls, "#455b59"],
    [building.doors, "#d1a662"],
    [building.exits, "#2c8c72"],
    [building.blocked_cells, "#b6574b"],
  ] as const) {
    context.fillStyle = color;
    cells.forEach((cell) =>
      context.fillRect(
        cell.x * cellSize + 1,
        cell.y * cellSize + 1,
        cellSize - 2,
        cellSize - 2,
      ),
    );
  }
  for (const exit of building.exits) {
    if (building.blocked_exit_ids.includes(exit.id)) {
      context.fillStyle = "#b6574b";
      context.fillRect(
        exit.x * cellSize + 1,
        exit.y * cellSize + 1,
        cellSize - 2,
        cellSize - 2,
      );
    }
  }
  if (selected) {
    context.strokeStyle = "#c9954b";
    context.lineWidth = 3;
    context.strokeRect(
      selected.x * cellSize + 2,
      selected.y * cellSize + 2,
      cellSize - 4,
      cellSize - 4,
    );
  }
}
