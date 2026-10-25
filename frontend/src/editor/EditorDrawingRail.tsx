import { furniturePresets, type FurnitureKind } from "./furniture";
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
        triggerClassName={`rail-button${isWallTool(tool) || tool === "wall-freehand" ? " is-selected" : ""}`}
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
            {choice(
              "wall-freehand",
              "Freehand curve",
              "Drag or click–trace–click · saved as segments",
              "curve",
              close,
            )}
            <details className="shape-note">
              <summary>Geometry details</summary>
              <p>
                Perimeters save as individual straight walls. Ellipses use 32
                segments; freehand curves use up to 96. Undo restores the whole
                drawing action. Freehand groups last this session; Alt-click
                selects one segment.
              </p>
            </details>
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
        triggerClassName={`rail-button${tool.startsWith("object-") || tool.startsWith("furniture-") ? " is-selected" : ""}`}
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
            <div className="object-curves">
              <button
                type="button"
                className="shape-choice"
                aria-label="Circle"
                disabled
              >
                <ToolIcon name="circle" />
                <span>
                  Circle<small>Collision unsupported</small>
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
                  Ellipse<small>Collision unsupported</small>
                </span>
              </button>
            </div>
            <div
              className="furniture-choices"
              role="group"
              aria-label="Furniture presets"
            >
              {Object.entries(furniturePresets).map(([kind, preset]) =>
                choice(
                  `furniture-${kind as FurnitureKind}`,
                  preset.label,
                  `${preset.width} × ${preset.height} m · blocks movement`,
                  kind,
                  close,
                ),
              )}
            </div>
            <p className="shape-note">
              All furniture, including chairs, blocks its full rectangle. Styles
              last this session. JSON and playback retain names and geometry.
            </p>
          </>
        )}
      </StudioPopover>
      {button("stairs", "Stairs", "stairs")}
      {button("tornado-zone", "Tornado zone", "shelter")}
    </div>
  );
}
