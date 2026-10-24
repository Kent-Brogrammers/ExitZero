import { useEffect, useRef } from "react";
import type { BuildingScenario } from "../types/simulation";

interface BuildingEditorProps {
  building: BuildingScenario;
}

export function BuildingEditor({ building }: BuildingEditorProps) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    const cellSize = 24;
    context.clearRect(
      0,
      0,
      building.width * cellSize,
      building.height * cellSize,
    );
    context.fillStyle = "#f8faf8";
    context.fillRect(
      0,
      0,
      building.width * cellSize,
      building.height * cellSize,
    );
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
      context.lineTo(x * cellSize, building.height * cellSize);
      context.stroke();
    }
    for (let y = 0; y <= building.height; y++) {
      context.beginPath();
      context.moveTo(0, y * cellSize);
      context.lineTo(building.width * cellSize, y * cellSize);
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
  }, [building]);

  // TODO(Developer 1): editing tools, spawn controls, and typed change callbacks.
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
        <span className="badge">Sample layout · read-only</span>
      </div>
      <div className="canvas-wrap">
        <canvas
          ref={canvas}
          width={building.width * 24}
          height={building.height * 24}
          role="img"
          aria-label={`Sample ${building.width} by ${building.height} building with ${building.exits.length} exits and ${building.spawn_zones.length} spawn zones. Editing is not implemented.`}
        />
      </div>
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
      <p className="note">
        Origin: top left. Each grid cell is one logical unit. Editing tools are
        the next workstream.
      </p>
    </section>
  );
}
