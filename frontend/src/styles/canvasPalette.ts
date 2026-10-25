const defaults = {
  grid: ["--cad-grid", "#252530"],
  gridMajor: ["--cad-grid-major", "#343442"],
  blueprint: ["--canvas-blueprint", "0"],
  background: ["--cad-bg", "#0a0a10"],
  surface: ["--cad-surface", "#101017"],
  wall: ["--cad-wall", "#adaab8"],
  door: ["--cad-door", "#c7a66f"],
  exit: ["--cad-success", "#38c99b"],
  selection: ["--cad-accent", "#5fa8f7"],
  danger: ["--cad-danger", "#e39486"],
  spawn: ["--cad-spawn", "#1c1c26"],
  spawnBorder: ["--cad-spawn-border", "#686575"],
  obstacle: ["--cad-obstacle", "#25221d"],
  obstacleBorder: ["--cad-obstacle-border", "#a18c73"],
  obstacleText: ["--cad-obstacle-text", "#d7c2a6"],
  shelter: ["--cad-shelter", "#b09ae3"],
  muted: ["--cad-muted", "#aaa8b8"],
} as const;
export type CanvasPalette = Record<keyof typeof defaults, string>;
export function canvasPalette(canvas: HTMLCanvasElement): CanvasPalette {
  const style = canvas.ownerDocument?.defaultView?.getComputedStyle(canvas);
  return Object.fromEntries(
    Object.entries(defaults).map(([key, [token, fallback]]) => [
      key,
      style?.getPropertyValue(token).trim() || fallback,
    ]),
  ) as CanvasPalette;
}
