import { StudioPopover } from "../ui/StudioPopover";
import { ToolIcon } from "./ToolIcon";
import { isWallTool, type EditorTool } from "./tools";

interface EditorDrawingRailProps {
  tool: EditorTool;
  disabled: boolean;
  onTool: (tool: EditorTool) => void;
  onOpenPanel: () => void;
}
const content = (icon: string, label: string) => (
  <>
    <ToolIcon name={icon} />
    <span>{label}</span>
  </>
);

export function EditorDrawingRail({
  tool,
  disabled,
  onTool,
  onOpenPanel,
}: EditorDrawingRailProps) {
  const button = (value: EditorTool, label: string, icon: string) => (
    <button
      key={value}
      type="button"
      className="studio-control rail-button"
      aria-label={label}
      title={label}
      aria-pressed={tool === value}
      disabled={disabled}
      onClick={() => onTool(value)}
    >
      {content(icon, label)}
    </button>
  );
  const choice = (
    value: EditorTool,
    label: string,
    detail: string,
    icon: string,
    close: () => void,
  ) => (
    <button
      type="button"
      className="shape-choice"
      aria-label={label}
      aria-pressed={tool === value}
      onClick={() => {
        close();
        onTool(value);
      }}
    >
      <ToolIcon name={icon} />
      <span>
        {label}
        <small>{detail}</small>
      </span>
    </button>
  );
  return (
    <div
      className="editor-rail editor-toolbar"
      role="toolbar"
      aria-label="Layout tools"
    >
      {button("select", "Select / move", "select")}
      <StudioPopover
        label="Walls & Shapes"
        side="right"
        className="editor-shapes"
        disabled={disabled}
        indicator={false}
        triggerClassName={`rail-button${isWallTool(tool) ? " is-selected" : ""}`}
        triggerContent={content("wall", "Walls & Shapes")}
        onOpen={onOpenPanel}
      >
        {(close) => (
          <>
            <div className="control-popover-heading">
              <h3>Walls & Shapes</h3>
              <button
                type="button"
                className="studio-control studio-control--icon"
                aria-label="Close wall shapes"
                onClick={close}
              >
                ×
              </button>
            </div>
            {choice(
              "wall",
              "Straight wall",
              "Drag a line at any angle",
              "wall",
              close,
            )}
            {choice(
              "wall-rectangle",
              "Rectangular wall perimeter",
              "Drag freely · Shift for square · 4 walls",
              "rectangle",
              close,
            )}
            {choice(
              "wall-circle",
              "Circle / ellipse wall perimeter",
              "Drag bounding box · Shift for circle",
              "circle",
              close,
            )}
            <p className="shape-note">
              Perimeters save as individual straight walls. Select a segment to
              edit, name, or delete it; undo restores the entire drawing action.
              Curves save as 32 straight segments, not exact arcs.
            </p>
          </>
        )}
      </StudioPopover>
      {button("door", "Door", "door")}
      {button("exit", "Exit", "exit")}
      {button("spawn", "Spawn zone", "spawn")}
      <StudioPopover
        label="Object / Obstacle"
        side="right"
        className="editor-shapes"
        disabled={disabled}
        indicator={false}
        triggerClassName={`rail-button${tool.startsWith("object-") ? " is-selected" : ""}`}
        triggerContent={content("obstruction", "Object")}
        onOpen={onOpenPanel}
      >
        {(close) => (
          <>
            <div className="control-popover-heading">
              <h3>Object / Obstacle</h3>
              <button
                type="button"
                className="studio-control studio-control--icon"
                aria-label="Close object shapes"
                onClick={close}
              >
                ×
              </button>
            </div>
            {choice(
              "object-rectangle",
              "Rectangle / square",
              "Drag freely · Shift for square",
              "rectangle",
              close,
            )}
            <button
              type="button"
              className="shape-choice"
              aria-label="Circle"
              disabled
            >
              <ToolIcon name="circle" />
              <span>
                Circle<small>Requires collision-contract approval</small>
              </span>
            </button>
            <button
              type="button"
              className="shape-choice"
              aria-label="Ellipse"
              disabled
            >
              <ToolIcon name="circle" />
              <span>
                Ellipse<small>Requires collision-contract approval</small>
              </span>
            </button>
            <p className="shape-note">
              Squares and rectangles save as rectangular obstructions. Resize
              width/height independently and give any object a name in
              Properties. Circular collision is not supported yet.
            </p>
          </>
        )}
      </StudioPopover>
      {button("stairs", "Stairs", "stairs")}
    </div>
  );
}
