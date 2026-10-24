export type EditorTool =
  | "select"
  | "wall-freehand"
  | "wall"
  | "wall-rectangle"
  | "wall-circle"
  | "door"
  | "exit"
  | "spawn"
  | "stairs"
  | "object-square"
  | "object-rectangle";

export const isWallTool = (
  tool: EditorTool,
): tool is "wall" | "wall-rectangle" | "wall-circle" =>
  tool === "wall" || tool === "wall-rectangle" || tool === "wall-circle";
