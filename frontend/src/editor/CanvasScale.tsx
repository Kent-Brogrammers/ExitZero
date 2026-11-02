import { useEffect, useState, type RefObject } from "react";
import type { BuildingScenario } from "../types/simulation";
import { canvasView, type CanvasCamera } from "./geometry";
import { scaleBar } from "./scaleBar";
import { useDisplayUnits } from "../utils/useDisplayUnits";
import "./CanvasScale.css";

/** Screen-space overlay: never enters building data, history, or simulation output. */
export function CanvasScale({
  canvas,
  building,
  camera,
}: {
  canvas: RefObject<HTMLCanvasElement | null>;
  building: BuildingScenario;
  camera?: CanvasCamera;
}) {
  const units = useDisplayUnits();
  const [viewport, setViewport] = useState({ width: 0, height: 0, ratio: 1 });
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      setViewport((previous) =>
        previous.width === width &&
        previous.height === height &&
        previous.ratio === ratio
          ? previous
          : { width, height, ratio },
      );
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [canvas]);
  if (viewport.height < 100) return null;
  // Match drawLayout's rounded backing dimensions, then convert back to CSS pixels.
  const backingWidth = Math.round(viewport.width * viewport.ratio);
  const view = canvasView(
    backingWidth,
    Math.round(viewport.height * viewport.ratio),
    building,
    camera,
    viewport.ratio,
  );
  const bar = scaleBar(
    (view.scale * viewport.width) / backingWidth,
    Math.min(112, viewport.width - 48),
    units,
  );
  if (!bar) return null;
  return (
    <div
      className="canvas-scale"
      role="img"
      aria-label={`Drawing scale: ${bar.label}`}
      style={{ width: bar.width }}
    >
      <div className="canvas-scale-labels" aria-hidden="true">
        <span>0</span>
        <span>{bar.label}</span>
      </div>
      <div className="canvas-scale-line" aria-hidden="true" />
    </div>
  );
}
