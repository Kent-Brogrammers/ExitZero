import type { ReactNode, Ref } from "react";
import { StudioPopover } from "../ui/StudioPopover";
import { DraftingControls } from "./DraftingControls";
import type { DraftingPreferences } from "./drafting";
import { ToolIcon } from "./ToolIcon";
import type { EditorTool } from "./tools";
import type { LayoutSaveActions } from "../templates/layouts";

interface EditorUtilityRailProps {
  saveActions?: LayoutSaveActions;
  scenarioControls?: ReactNode;
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  tool: EditorTool;
  showShelter: boolean;
  propertiesOpen: boolean;
  propertiesButton: Ref<HTMLButtonElement>;
  onUndo: () => void;
  onRedo: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onTool: (tool: EditorTool) => void;
  onNew: () => void;
  onImport: () => void;
  onImportDxf: () => void;
  onExport: () => void;
  onProperties: () => void;
  canvasControls: ReactNode;
  drafting: DraftingPreferences;
  onDrafting: (p: DraftingPreferences) => void;
}

type HistoryProps = Pick<
  EditorUtilityRailProps,
  "disabled" | "canUndo" | "canRedo" | "onUndo" | "onRedo"
>;
export function EditorHistoryControls(props: HistoryProps) {
  return (
    <div className="editor-history" role="group" aria-label="History controls">
      <button
        type="button"
        className="studio-control editor-tool-button"
        disabled={props.disabled || !props.canUndo}
        onClick={props.onUndo}
        aria-label="Undo"
        title="Undo (Ctrl/Cmd+Z on Canvas)"
      >
        <ToolIcon name="undo" />
      </button>
      <button
        type="button"
        className="studio-control editor-tool-button"
        disabled={props.disabled || !props.canRedo}
        onClick={props.onRedo}
        aria-label="Redo"
        title="Redo (Ctrl/Cmd+Shift+Z on Canvas)"
      >
        <ToolIcon name="redo" />
      </button>
    </div>
  );
}

export function EditorUtilityRail(props: EditorUtilityRailProps) {
  return (
    <div className="editor-menubar" role="toolbar" aria-label="Editor menus">
      <StudioPopover
        label="File"
        className="editor-file"
        disabled={props.disabled}
      >
        {(close) => (
          <div className="file-actions">
            {props.saveActions && (
              <>
                {(
                  [
                    ["Save", props.saveActions.save],
                    ["Save As…", props.saveActions.saveAs],
                    ["Save as Template…", props.saveActions.saveTemplate],
                    ["Open Saved Layouts", props.saveActions.open],
                  ] as const
                ).map(([label, action]) => (
                  <button
                    key={label}
                    type="button"
                    className="studio-control"
                    onClick={() => {
                      close();
                      action();
                    }}
                  >
                    {label}
                  </button>
                ))}
                <hr />
              </>
            )}
            {(
              [
                ["New Layout", props.onNew],
                ["Import JSON", props.onImport],
                ["Import DXF", props.onImportDxf],
                ["Export JSON", props.onExport],
              ] as const
            ).map(([label, action]) => (
              <button
                type="button"
                className="studio-control"
                key={label}
                onClick={() => {
                  close();
                  action();
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </StudioPopover>
      <StudioPopover
        label="Edit"
        className="editor-file"
        disabled={props.disabled}
      >
        {(close) => (
          <div className="file-actions">
            {(
              [
                ["Undo", props.onUndo, !props.canUndo, "Ctrl/Cmd+Z"],
                ["Redo", props.onRedo, !props.canRedo, "Ctrl/Cmd+Shift+Z"],
                [
                  "Duplicate selection",
                  props.onDuplicate,
                  !props.hasSelection,
                  "Ctrl/Cmd+D",
                ],
                [
                  "Delete selection",
                  props.onDelete,
                  !props.hasSelection,
                  "Delete",
                ],
              ] as const
            ).map(([label, action, disabled, keys]) => (
              <button
                type="button"
                className="studio-control"
                key={label}
                disabled={disabled}
                title={keys}
                onClick={() => {
                  close();
                  action();
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </StudioPopover>
      <StudioPopover
        label="Insert"
        className="editor-shapes"
        disabled={props.disabled}
        triggerClassName={
          props.tool === "stairs" || props.tool === "tornado-zone"
            ? "is-selected"
            : ""
        }
      >
        {(close) => (
          <>
            <div className="control-popover-heading">
              <h3>Architectural areas</h3>
            </div>
            <button
              type="button"
              className="shape-choice"
              aria-pressed={props.tool === "stairs"}
              onClick={() => {
                close();
                props.onTool("stairs");
              }}
            >
              <ToolIcon name="stairs" />
              <span>
                Stair area
                <small>
                  Walkable single-floor marker · no floor connections
                </small>
              </span>
            </button>
            {props.showShelter && (
              <button
                type="button"
                className="shape-choice"
                aria-pressed={props.tool === "tornado-zone"}
                onClick={() => {
                  close();
                  props.onTool("tornado-zone");
                }}
              >
                <ToolIcon name="shelter" />
                <span>
                  Tornado shelter zone
                  <small>Drag an indoor shelter destination</small>
                </span>
              </button>
            )}
          </>
        )}
      </StudioPopover>
      <StudioPopover
        label="View"
        className="editor-view"
        disabled={props.disabled}
      >
        {() => (
          <>
            <details className="view-canvas-section">
              <summary>Drawing area & fullscreen</summary>
              {props.canvasControls}
            </details>
            <DraftingControls
              preferences={props.drafting}
              onChange={props.onDrafting}
            />
          </>
        )}
      </StudioPopover>
      {props.scenarioControls}
      <button
        ref={props.propertiesButton}
        type="button"
        className="studio-control editor-properties-button"
        aria-label="Properties"
        title="Properties"
        disabled={props.disabled}
        aria-expanded={props.propertiesOpen}
        aria-controls="editor-properties"
        onClick={props.onProperties}
      >
        <ToolIcon name="properties" />
        <span>Properties</span>
      </button>
    </div>
  );
}
