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
  continuous = false,
) {
  if (!p.visible) return;
  const spacing = gridSpacings[p.spacing].metres,
    stride = gridStride(
      spacing,
      view.scale / ratio,
      Math.max(b.width, b.height),
    );
  const left = continuous ? -view.x / view.scale : 0;
  const top = continuous ? -view.y / view.scale : 0;
  const right = continuous ? (ctx.canvas.width - view.x) / view.scale : b.width;
  const bottom = continuous
    ? (ctx.canvas.height - view.y) / view.scale
    : b.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = 1;
  for (const major of [false, true]) {
    ctx.beginPath();
    ctx.strokeStyle = major ? palette.gridMajor : palette.grid;
    for (
      let i = Math.floor(left / spacing / stride) * stride;
      i * spacing < right;
      i += stride
    )
      if ((i % 5 === 0) === major) {
        const x = Math.floor(view.x + i * spacing * view.scale) + 0.5;
        ctx.moveTo(x, view.y + top * view.scale);
        ctx.lineTo(x, view.y + bottom * view.scale);
      }
    for (
      let i = Math.floor(top / spacing / stride) * stride;
      i * spacing < bottom;
      i += stride
    )
      if ((i % 5 === 0) === major) {
        const y = Math.floor(view.y + i * spacing * view.scale) + 0.5;
        ctx.moveTo(view.x + left * view.scale, y);
        ctx.lineTo(view.x + right * view.scale, y);
      }
    ctx.stroke();
  }
  ctx.restore();
}
