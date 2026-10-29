import type { FurnitureTool } from "./furniture";
export type EditorTool =
  | FurnitureTool
  | "select"
  | "wall-freehand"
  | "wall"
  | "wall-rectangle"
  | "wall-circle"
  | "door"
  | "window"
  | "spawn"
  | "spawn-room"
  | "stairs"
  | "tornado-zone"
  | "hazard"
  | "object-square"
  | "object-rectangle";

export const isWallTool = (
  tool: EditorTool,
): tool is "wall" | "wall-rectangle" | "wall-circle" =>
  tool === "wall" || tool === "wall-rectangle" || tool === "wall-circle";
