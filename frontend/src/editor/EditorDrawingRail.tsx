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
              "Drag opposite corners · 4 walls",
              "rectangle",
              close,
            )}
            {choice(
              "wall-circle",
              "Circular wall perimeter",
              "Drag centre to radius · 24 segments",
              "circle",
              close,
            )}
            <p className="shape-note">
              Perimeters save as individual straight walls. Select a segment to
              edit, name, or delete it; undo restores the entire drawing action.
              Circles are segmented approximations, not arcs.
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
              "object-square",
              "Square",
              "Drag to size · physical obstacle",
              "square",
              close,
            )}
            {choice(
              "object-rectangle",
              "Rectangle",
              "Drag opposite corners · physical obstacle",
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
            <p className="shape-note">
              Squares and rectangles save as rectangular obstructions. Resize
              width/height independently and give any object a name in
              Properties. Circular collision is not supported yet.
            </p>
          </>
        )}
      </StudioPopover>
      <StudioPopover
        label="Stairs"
        side="right"
        className="editor-shapes"
        disabled={disabled}
        indicator={false}
        triggerClassName="rail-button"
        triggerContent={content("stairs", "Stairs")}
        onOpen={onOpenPanel}
      >
        {(close) => (
          <>
            <div className="control-popover-heading">
              <h3>Stair areas</h3>
              <button
                type="button"
                className="studio-control studio-control--icon"
                aria-label="Close stair information"
                onClick={close}
              >
                ×
              </button>
            </div>
            <p className="shape-note">
              Stair markers need an agreed, persistent area contract before they
              can be drawn. No stair geometry is saved or simulated yet.
            </p>
            <p className="shape-note">
              A marker will not transport occupants between floors. Multi-floor
              navigation is tracked separately in{" "}
              <a
                href="https://github.com/Kent-Brogrammers/ExitZero/issues/11"
                target="_blank"
                rel="noreferrer"
              >
                issue #11
              </a>
              .
            </p>
          </>
        )}
      </StudioPopover>
    </div>
  );
}
