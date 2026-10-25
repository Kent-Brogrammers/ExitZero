import type { Point } from "../types/simulation";

/** Original geometric mask symbol; no licensed images or character artwork. */
export function drawStalker(
  context: CanvasRenderingContext2D,
  point: Point,
  radius: number,
) {
  context.save();
  context.fillStyle = "#ed5a65";
  context.strokeStyle = "#24172d";
  context.lineWidth = radius * 0.12;
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.fillStyle = "#f0e9df";
  context.beginPath();
  context.ellipse(
    point.x,
    point.y,
    radius * 0.49,
    radius * 0.66,
    0,
    0,
    Math.PI * 2,
  );
  context.fill();
  context.fillStyle = "#302539";
  for (const side of [-1, 1]) {
    context.beginPath();
    context.arc(
      point.x + side * radius * 0.2,
      point.y - radius * 0.15,
      radius * 0.1,
      0,
      Math.PI * 2,
    );
    context.fill();
  }
  context.restore();
}
