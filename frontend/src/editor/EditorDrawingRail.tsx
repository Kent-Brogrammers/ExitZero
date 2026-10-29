import type { ReactNode } from "react";
import { formatDimensions } from "../utils/units";
import { furniturePresets, type FurnitureKind } from "./furniture";
import { StudioPopover } from "../ui/StudioPopover";
import { ToolIcon } from "./ToolIcon";
import { isWallTool, type EditorTool } from "./tools";

interface EditorDrawingRailProps {
  tool: EditorTool;
  disabled: boolean;
  onTool: (tool: EditorTool) => void;
  onOpenPanel: () => void;
  historyControls?: ReactNode;
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
  historyControls,
}: EditorDrawingRailProps) {
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
    <div className="editor-toolbar" role="toolbar" aria-label="Layout tools">
      {historyControls}
      <span className="toolbar-separator" aria-hidden="true" />
      <button
        type="button"
        className="studio-control editor-tool-button"
        aria-label="Select / move"
        title="Select / move"
        aria-pressed={tool === "select"}
        disabled={disabled}
        onClick={() => onTool("select")}
      >
        {content("select", "Select")}
      </button>
      <StudioPopover
        label="Walls"
        className="editor-shapes"
        disabled={disabled}
        triggerClassName={`editor-tool-button${isWallTool(tool) || tool === "wall-freehand" ? " is-selected" : ""}`}
        triggerContent={content("wall", "Walls")}
        onOpen={onOpenPanel}
      >
        {(close) => (
          <>
            <div className="control-popover-heading">
              <h3>Walls</h3>
            </div>
            {choice(
              "wall",
              "Straight wall",
              "Any angle · Shift locks to 45°",
              "wall",
              close,
            )}
            {choice(
              "wall-rectangle",
              "Rectangular wall perimeter",
              "Drag freely · Shift for square",
              "rectangle",
              close,
            )}
            {choice(
              "wall-circle",
              "Circle / ellipse wall perimeter",
              "Drag freely · Shift for circle · 32 segments",
              "circle",
              close,
            )}
            <details className="toolbar-advanced">
              <summary>Advanced</summary>
              {choice(
                "wall-freehand",
                "Freehand curve",
                "Drag or click–trace–click · up to 96 segments",
                "curve",
                close,
              )}
              <p className="shape-note">
                Curves save as straight wall segments. Freehand grouping lasts
                this session; Alt-click selects one segment.
              </p>
            </details>
          </>
        )}
      </StudioPopover>
      <StudioPopover
        label="Openings"
        className="editor-shapes"
        disabled={disabled}
        triggerClassName={`editor-tool-button${["door", "window"].includes(tool) ? " is-selected" : ""}`}
        triggerContent={content("door", "Openings")}
        onOpen={onOpenPanel}
      >
        {(close) => (
          <>
            <div className="control-popover-heading">
              <h3>Openings</h3>
            </div>
            {choice(
              "door",
              "Door",
              "Exterior doors become exits · Edit width and blocking in Properties",
              "door",
              close,
            )}
            {choice(
              "window",
              "Window",
              "Configure emergency escape in Properties",
              "window",
              close,
            )}
          </>
        )}
      </StudioPopover>
      <StudioPopover
        label="People"
        className="editor-shapes"
        disabled={disabled}
        triggerClassName={`editor-tool-button${["spawn", "spawn-polygon", "spawn-room", "occupant"].includes(tool) ? " is-selected" : ""}`}
        triggerContent={content("spawn", "People")}
        onOpen={onOpenPanel}
      >
        {(close) => (
          <>
            <div className="control-popover-heading">
              <h3>People</h3>
            </div>
            {choice(
              "spawn",
              "Draw Zone",
              "Drag a rectangular spawn area",
              "rectangle",
              close,
            )}
            {choice(
              "spawn-polygon",
              "Draw Polygon",
              "Click vertices, then close the polygon",
              "spawn",
              close,
            )}
            {choice(
              "spawn-room",
              "Fill Room",
              "Click inside an enclosed room",
              "spawn",
              close,
            )}
            {choice(
              "occupant",
              "Place occupant",
              "Click an exact starting position",
              "spawn",
              close,
            )}
          </>
        )}
      </StudioPopover>
      <StudioPopover
        label="Objects"
        className="editor-shapes"
        disabled={disabled}
        triggerClassName={`editor-tool-button${tool.startsWith("object-") || tool.startsWith("furniture-") ? " is-selected" : ""}`}
        triggerContent={content("obstruction", "Objects")}
        onOpen={onOpenPanel}
      >
        {(close) => (
          <>
            <div className="control-popover-heading">
              <h3>Objects & furniture</h3>
            </div>
            {choice(
              "object-rectangle",
              "Rectangle / square",
              "Drag a solid footprint · Shift for square",
              "rectangle",
              close,
            )}
            <div
              className="furniture-choices"
              role="group"
              aria-label="Furniture presets"
            >
              {Object.entries(furniturePresets).map(([kind, preset]) => (
                <div key={kind}>
                  {choice(
                    `furniture-${kind as FurnitureKind}`,
                    preset.label,
                    kind === "chair"
                      ? "Solid rectangular blocker · no seated behavior"
                      : `${formatDimensions(preset.width, preset.height)} · blocks movement`,
                    kind,
                    close,
                  )}
                </div>
              ))}
            </div>
            <p className="shape-note">
              Furniture blocks its full rectangular footprint. JSON retains
              names and geometry; drawing styles last this session.
            </p>
          </>
        )}
      </StudioPopover>
    </div>
  );
}
