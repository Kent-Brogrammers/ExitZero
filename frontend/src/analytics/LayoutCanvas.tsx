import { useEffect, useRef } from "react";
import { drawLayout } from "../editor/draw";
import { canvasView, openingSegment } from "../editor/geometry";
import { canvasPalette } from "../styles/canvasPalette";
import { openingChanges, openingWidthChanges } from "./optimization";
import { useStudioTheme } from "../styles/appearance";
import type { BuildingScenario, TrafficSample } from "../types/simulation";
import { trafficCells } from "./traffic";
import "./analysis.css";

export function LayoutCanvas({
  building,
  label,
  samples,
  comparisonBuilding,
}: {
  building: BuildingScenario;
  label: string;
  samples?: TrafficSample[];
  comparisonBuilding?: BuildingScenario;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useStudioTheme();
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const cells = samples
      ? trafficCells(samples, building.width, building.height)
      : [];
    const maximum = cells.reduce((max, cell) => Math.max(max, cell.visits), 0);
    const changes = comparisonBuilding
      ? openingWidthChanges(comparisonBuilding, building)
      : [];
    const redraw = () => {
      drawLayout(
        target,
        building,
        changes.length
          ? changes.map((change) => ({
              kind: change.kind,
              id: change.proposed.id,
            }))
          : null,
        undefined,
        window.devicePixelRatio,
      );
      const context = target.getContext("2d");
      const bounds = target.getBoundingClientRect();
      if (!context || !bounds.width || !bounds.height) return;
      const view = canvasView(target.width, target.height, building);
      context.setTransform(view.scale, 0, 0, view.scale, view.x, view.y);
      for (const cell of cells) {
        context.fillStyle = `rgba(255, 152, 58, ${0.08 + (0.67 * cell.visits) / maximum})`;
        context.fillRect(cell.x, cell.y, cell.width, cell.height);
      }
      if (!comparisonBuilding || !changes.length) return;
      const palette = canvasPalette(target);
      const pixel = (window.devicePixelRatio || 1) / view.scale;
      context.save();
      context.lineCap = "butt";
      for (const change of changes) {
        const originalWall = comparisonBuilding.walls.find(
          (wall) => wall.id === change.original.wall_id,
        );
        const proposedWall = building.walls.find(
          (wall) => wall.id === change.proposed.wall_id,
        );
        if (!originalWall || !proposedWall) continue;
        const proposed = openingSegment(change.proposed, proposedWall);
        const original = openingSegment(change.original, originalWall);
        context.setLineDash([]);
        context.strokeStyle = palette.selection;
        context.lineWidth = 6 * pixel;
        context.beginPath();
        context.moveTo(proposed[0].x, proposed[0].y);
        context.lineTo(proposed[1].x, proposed[1].y);
        context.stroke();
        for (const point of proposed) {
          context.beginPath();
          context.arc(point.x, point.y, 4 * pixel, 0, Math.PI * 2);
          context.fillStyle = palette.selection;
          context.fill();
        }
        context.setLineDash([5 * pixel, 4 * pixel]);
        context.strokeStyle = palette.door;
        context.lineWidth = 2 * pixel;
        context.beginPath();
        context.moveTo(original[0].x, original[0].y);
        context.lineTo(original[1].x, original[1].y);
        context.stroke();
      }
      context.restore();
    };
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(target);
    return () => observer.disconnect();
  }, [building, samples, theme, comparisonBuilding]);
  return (
    <canvas
      ref={canvas}
      className="analysis-canvas"
      width="900"
      height="600"
      role="img"
      aria-label={
        comparisonBuilding
          ? `${label}. Highlighted opening changes: ${openingChanges(comparisonBuilding, building).join("; ") || "None"}. Dashed original opening; solid proposed opening.`
          : label
      }
    />
  );
}
