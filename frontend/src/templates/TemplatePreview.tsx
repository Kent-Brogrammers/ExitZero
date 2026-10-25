import { useEffect, useRef } from "react";
import type { BuildingScenario } from "../types/simulation";
import { drawLayout } from "../editor/draw";
import { canvasPalette } from "../styles/canvasPalette";

export function TemplatePreview({
  building,
  name,
}: {
  building: BuildingScenario;
  name: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const redraw = () =>
      drawLayout(
        target,
        building,
        null,
        undefined,
        window.devicePixelRatio || 1,
        canvasPalette(target),
        {
          showLabels: false,
          showDimensions: false,
          grid: {
            visible: true,
            snap: false,
            spacing: "1m",
            doorMergeTolerance: 0.1,
          },
        },
      );
    const observer = new ResizeObserver(redraw);
    observer.observe(target);
    window.addEventListener("resize", redraw);
    redraw();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", redraw);
    };
  }, [building]);
  return (
    <canvas
      ref={canvas}
      className="template-preview"
      data-world-canvas=""
      role="img"
      aria-label={`${name} floor plan preview`}
    />
  );
}
