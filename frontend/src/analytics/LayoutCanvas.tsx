import { useEffect, useRef } from "react";
import { drawLayout } from "../editor/draw";
import { canvasView } from "../editor/geometry";
import { useStudioTheme } from "../styles/appearance";
import type { BuildingScenario, TrafficSample } from "../types/simulation";
import { trafficCells } from "./traffic";
import "./analysis.css";

export function LayoutCanvas({
  building,
  label,
  samples,
}: {
  building: BuildingScenario;
  label: string;
  samples?: TrafficSample[];
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
    const redraw = () => {
      drawLayout(target, building, null, undefined, window.devicePixelRatio);
      const context = target.getContext("2d");
      const bounds = target.getBoundingClientRect();
      if (!context || !bounds.width || !bounds.height) return;
      const view = canvasView(target.width, target.height, building);
      context.setTransform(view.scale, 0, 0, view.scale, view.x, view.y);
      for (const cell of cells) {
        context.fillStyle = `rgba(255, 152, 58, ${0.08 + (0.67 * cell.visits) / maximum})`;
        context.fillRect(cell.x, cell.y, cell.width, cell.height);
      }
    };
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(target);
    return () => observer.disconnect();
  }, [building, samples, theme]);
  return (
    <canvas
      ref={canvas}
      className="analysis-canvas"
      width="900"
      height="600"
      role="img"
      aria-label={label}
    />
  );
}
