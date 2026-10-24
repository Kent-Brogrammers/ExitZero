import type { BuildingScenario } from "../types/simulation";
import type { CanvasPalette } from "../styles/canvasPalette";
import { gridSpacings, gridStride, type DraftingPreferences } from "./drafting";
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  b: BuildingScenario,
  view: { scale: number; x: number; y: number },
  ratio: number,
  p: DraftingPreferences,
  palette: CanvasPalette,
) {
  if (!p.visible) return;
  const spacing = gridSpacings[p.spacing].metres,
    stride = gridStride(
      spacing,
      view.scale / ratio,
      Math.max(b.width, b.height),
    );
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = 1;
  for (const major of [false, true]) {
    ctx.beginPath();
    ctx.strokeStyle = major ? palette.gridMajor : palette.grid;
    for (let i = stride; i * spacing < b.width; i += stride)
      if ((i % 5 === 0) === major) {
        const x = Math.floor(view.x + i * spacing * view.scale) + 0.5;
        ctx.moveTo(x, view.y);
        ctx.lineTo(x, view.y + b.height * view.scale);
      }
    for (let i = stride; i * spacing < b.height; i += stride)
      if ((i % 5 === 0) === major) {
        const y = Math.floor(view.y + i * spacing * view.scale) + 0.5;
        ctx.moveTo(view.x, y);
        ctx.lineTo(view.x + b.width * view.scale, y);
      }
    ctx.stroke();
  }
  ctx.restore();
}
