import type { ReactNode, Ref } from "react";
import { StudioPopover } from "../ui/StudioPopover";
import { DraftingControls } from "./DraftingControls";
import type { DraftingPreferences } from "./drafting";
import { ToolIcon } from "./ToolIcon";
import type { LayoutSaveActions } from "../templates/layouts";

interface EditorUtilityRailProps {
  saveActions?: LayoutSaveActions;
  scenarioControls?: ReactNode;
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  propertiesOpen: boolean;
  propertiesButton: Ref<HTMLButtonElement>;
  onUndo: () => void;
  onRedo: () => void;
  onNew: () => void;
  onImport: () => void;
  onImportDxf: () => void;
  onExport: () => void;
  onProperties: () => void;
  canvasControls: ReactNode;
  drafting: DraftingPreferences;
  onDrafting: (p: DraftingPreferences) => void;
}
const content = (name: string, label: string) => (
  <>
    <ToolIcon name={name} />
    <span>{label}</span>
  </>
);

export function EditorUtilityRail(props: EditorUtilityRailProps) {
  return (
    <div
      className="editor-rail editor-utility-rail"
      role="toolbar"
      aria-label="Editor utilities"
    >
      <div className="rail-history" role="group" aria-label="History controls">
        <button
          type="button"
          className="studio-control rail-button"
          disabled={props.disabled || !props.canUndo}
          onClick={props.onUndo}
          title="Undo (Ctrl/Cmd+Z on Canvas)"
        >
          {content("undo", "Undo")}
        </button>
        <button
          type="button"
          className="studio-control rail-button"
          disabled={props.disabled || !props.canRedo}
          onClick={props.onRedo}
          title="Redo (Ctrl/Cmd+Shift+Z on Canvas)"
        >
          {content("redo", "Redo")}
        </button>
      </div>
      <span className="rail-separator" aria-hidden="true" />
      {props.scenarioControls}
      <StudioPopover
        label="File"
        className="editor-file"
        disabled={props.disabled}
        side="left"
        triggerClassName="rail-button"
        triggerContent={content("file", "File")}
        indicator={false}
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
      <button
        type="button"
        className="studio-control rail-button"
        disabled={props.disabled}
        onClick={props.onNew}
        title="Clear the plan (Undo restores it)"
      >
        {content("clear", "Clear Plan")}
      </button>
      <StudioPopover
        label="Grid & snap"
        side="left"
        className="editor-shapes"
        disabled={props.disabled}
        triggerClassName="rail-button"
        triggerContent={content("grid", "Grid")}
        indicator={false}
      >
        {() => (
          <DraftingControls
            preferences={props.drafting}
            onChange={props.onDrafting}
          />
        )}
      </StudioPopover>
      <StudioPopover
        label="Canvas"
        side="left"
        className="editor-canvas-settings"
        disabled={props.disabled}
        triggerClassName="rail-button"
        triggerContent={content("expand", "Canvas")}
        indicator={false}
      >
        {() => props.canvasControls}
      </StudioPopover>
      <button
        ref={props.propertiesButton}
        type="button"
        className="studio-control rail-button"
        disabled={props.disabled}
        aria-expanded={props.propertiesOpen}
        aria-controls="editor-properties"
        onClick={props.onProperties}
      >
        {content("properties", "Properties")}
      </button>
    </div>
  );
}
