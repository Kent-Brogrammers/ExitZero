import { LayoutNameDialog } from "./LayoutNameDialog";
import { storeLayout } from "./layouts";
import { formatDimensions } from "../utils/units";
import { useState } from "react";
import type { BuildingScenario } from "../types/simulation";
import { buildingPresets } from "../editor/presets";
import { emergencyPresets } from "../editor/emergencyPresets";
import { buildingError } from "../editor/geometry";
import { TemplateCard } from "./TemplateCard";
import { readTemplates, writeTemplates, type UserTemplate } from "./templates";
import "./TemplatesPage.css";

interface TemplatesPageProps {
  building: BuildingScenario;
  busy: boolean;
  online: boolean;
  onOpen: (
    building: BuildingScenario,
    name: string,
    action: "edit" | "simulate",
    source?: UserTemplate,
  ) => void;
  onSaved: (building: BuildingScenario) => void;
  onOfficeRecording: () => void;
  onSaveLayout?: () => void;
  onSaveTemplate?: () => void;
  onEntryChanged?: (id: string, entry: UserTemplate | null) => void;
}

export function TemplatesPage({
  building,
  busy,
  online,
  onOpen,
  onSaved,
  onOfficeRecording,
  onSaveLayout,
  onSaveTemplate,
  onEntryChanged,
}: TemplatesPageProps) {
  const [initial] = useState(() => {
    try {
      return {
        templates:
          typeof window === "undefined"
            ? []
            : readTemplates(window.localStorage),
        error: "",
      };
    } catch {
      return {
        templates: [],
        error:
          "My Templates could not be read. Existing browser storage has not been overwritten. You can still export your layout as JSON.",
      };
    }
  });
  const [templates, setTemplates] = useState<UserTemplate[]>(initial.templates);
  const [error, setError] = useState("");
  const [nameAction, setNameAction] = useState<{
    entry?: UserTemplate;
    duplicate?: boolean;
  } | null>(null);
  const saveProblem = buildingError(building, false);
  function persist(next: UserTemplate[]) {
    try {
      writeTemplates(window.localStorage, next);
      setTemplates(next);
      setError("");
      return true;
    } catch {
      setError(
        "Could not save templates in this browser. Storage may be full or unavailable. Your layout and saved templates are unchanged; export JSON to keep a file.",
      );
      return false;
    }
  }
  function saveCurrent() {
    if (onSaveTemplate) onSaveTemplate();
    else setNameAction({});
  }
  function confirmName(name: string) {
    const entry = nameAction?.entry;
    const saved = storeLayout(
      window.localStorage,
      entry?.building ?? building,
      name,
      entry?.kind === "layout" ? "layout" : "template",
      nameAction?.duplicate ? undefined : entry,
    );
    setTemplates(readTemplates(window.localStorage));
    onEntryChanged?.(saved.id, saved);
    if (!entry) onSaved(building);
  }
  function card(
    name: string,
    layout: BuildingScenario,
    custom?: UserTemplate,
    savedRecording = false,
    description?: string,
  ) {
    return (
      <TemplateCard
        name={name}
        building={layout}
        busy={busy}
        online={online}
        onEdit={() => onOpen(layout, name, "edit", custom)}
        onRun={() => onOpen(layout, name, "simulate", custom)}
        key={custom?.id ?? name}
      >
        {description && <p className="templates-local-note">{description}</p>}
        {savedRecording && (
          <button
            type="button"
            className="template-secondary"
            disabled={busy}
            onClick={onOfficeRecording}
          >
            View saved office recording →
          </button>
        )}
        {custom && (
          <div className="template-secondary-actions">
            <button
              type="button"
              className="template-secondary"
              disabled={busy}
              onClick={() => setNameAction({ entry: custom })}
            >
              Rename
            </button>
            <button
              type="button"
              className="template-secondary"
              disabled={busy}
              onClick={() => setNameAction({ entry: custom, duplicate: true })}
            >
              Duplicate
            </button>
            <button
              type="button"
              className="template-secondary"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete “${name}” from ${custom.kind === "layout" ? "Saved Layouts" : "My Templates"}? Your current layout will stay unchanged.`,
                  )
                ) {
                  try {
                    if (
                      persist(
                        readTemplates(window.localStorage).filter(
                          (t) => t.id !== custom.id,
                        ),
                      )
                    )
                      onEntryChanged?.(custom.id, null);
                  } catch {
                    setError(
                      "Saved layouts could not be read. Existing storage has not been overwritten.",
                    );
                  }
                }
              }}
            >
              Delete
            </button>
          </div>
        )}
      </TemplateCard>
    );
  }
  return (
    <div className="templates-page">
      <header className="templates-heading">
        <h1>Templates</h1>
        <p>Start with a floor plan. Make it your own.</p>
      </header>
      <section aria-label="Built-in templates">
        <h2>Built-in templates</h2>
        <div className="template-gallery">
          {buildingPresets.map((preset) =>
            card(
              preset.label,
              preset.building,
              undefined,
              preset.id === "office-demo",
            ),
          )}
        </div>
      </section>
      <section aria-label="Emergency Scenarios">
        <h2>Emergency Scenarios</h2>
        <p className="templates-local-note">
          Evolving hazards and physical escape challenges. Edit the layout,
          adjust the emergency, or run the scenario as configured.
        </p>
        <div className="template-gallery">
          {emergencyPresets.map((preset) =>
            card(
              preset.label,
              preset.building,
              undefined,
              false,
              preset.description,
            ),
          )}
        </div>
      </section>
      <section aria-label="Saved Layouts" id="saved-layouts">
        <h2>Saved Layouts</h2>
        <p className="templates-local-note">
          Open a layout to continue working. Save updates that copy; Save As
          keeps a separate version.
        </p>
        {onSaveLayout && (
          <button
            type="button"
            className="studio-control"
            disabled={busy || !!initial.error || !!saveProblem}
            onClick={onSaveLayout}
          >
            Save Current Layout
          </button>
        )}
        {!templates.some((entry) => entry.kind === "layout") && (
          <p className="templates-local-note">
            No saved layouts yet. Use Save in the editor to name your first
            layout.
          </p>
        )}
        <div className="template-gallery">
          {templates
            .filter((entry) => entry.kind === "layout")
            .map((entry) => card(entry.name, entry.building, entry))}
        </div>
      </section>
      <section aria-label="My Templates">
        <h2>My Templates</h2>
        <p className="templates-local-note">
          Saved only in this browser. JSON preserves building geometry and
          names; furniture drawing styles remain session-only.
        </p>
        {(initial.error || error) && (
          <p className="templates-error" role="alert">
            {initial.error || error}
          </p>
        )}
        <div className="template-gallery">
          <button
            type="button"
            className="template-save-card"
            disabled={busy || !!initial.error || !!saveProblem}
            title={
              saveProblem ?? "Save a reusable copy of your current floor plan."
            }
            onClick={saveCurrent}
          >
            <span aria-hidden="true">＋</span>
            <strong>Save as Template</strong>
            <span>
              {formatDimensions(building.width, building.height)} · Name your
              template
            </span>
          </button>
          {templates
            .filter((template) => template.kind !== "layout")
            .map((template) =>
              card(template.name, template.building, template),
            )}
        </div>
      </section>
      {nameAction && (
        <LayoutNameDialog
          title={
            nameAction.entry
              ? nameAction.duplicate
                ? "Duplicate saved layout"
                : "Rename saved layout"
              : "Save as template"
          }
          initialName={
            nameAction.entry
              ? nameAction.duplicate
                ? `${nameAction.entry.name.slice(0, 75)} copy`
                : nameAction.entry.name
              : "My template"
          }
          action={
            nameAction.entry
              ? nameAction.duplicate
                ? "Duplicate"
                : "Rename"
              : "Save as Template"
          }
          onConfirm={confirmName}
          onClose={() => setNameAction(null)}
        />
      )}
    </div>
  );
}
