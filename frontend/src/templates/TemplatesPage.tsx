import { useState } from "react";
import type { BuildingScenario } from "../types/simulation";
import { buildingPresets } from "../editor/presets";
import { buildingError } from "../editor/geometry";
import { TemplatePreview } from "./TemplatePreview";
import {
  createTemplate,
  readTemplates,
  writeTemplates,
  templateName,
  type UserTemplate,
} from "./templates";
import "./TemplatesPage.css";

interface TemplatesPageProps {
  building: BuildingScenario;
  busy: boolean;
  online: boolean;
  onOpen: (
    building: BuildingScenario,
    name: string,
    action: "edit" | "simulate",
  ) => void;
  onSaved: (building: BuildingScenario) => void;
  onOfficeRecording: () => void;
}

export function TemplatesPage({
  building,
  busy,
  online,
  onOpen,
  onSaved,
  onOfficeRecording,
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
    const name = window.prompt("Template name (1–80 characters)", "My layout");
    if (name === null) return;
    try {
      const next = createTemplate(building, name);
      if (persist([...templates, next])) onSaved(building);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this layout.");
    }
  }
  function rename(template: UserTemplate) {
    const name = window.prompt(
      "Rename template (1–80 characters)",
      template.name,
    );
    if (name === null) return;
    try {
      const nextName = templateName(name);
      persist(
        templates.map((t) =>
          t.id === template.id ? { ...t, name: nextName } : t,
        ),
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not rename this template.",
      );
    }
  }
  function card(
    name: string,
    layout: BuildingScenario,
    custom?: UserTemplate,
    savedRecording = false,
  ) {
    const problem = buildingError(layout);
    return (
      <article
        className="template-card"
        aria-label={`${name} template`}
        key={custom?.id ?? name}
      >
        <TemplatePreview building={layout} name={name} />
        <div className="template-card-content">
          <h3>{name}</h3>
          <p className="template-metadata">
            {layout.width} × {layout.height} m <span aria-hidden="true">·</span>{" "}
            {layout.spawn_zones.reduce((count, zone) => count + zone.count, 0)}{" "}
            occupants
          </p>
          <div className="template-actions">
            <button
              type="button"
              className="studio-control"
              disabled={busy}
              onClick={() => onOpen(layout, name, "edit")}
            >
              Edit
            </button>
            <button
              type="button"
              className="studio-control"
              disabled={busy || !online || !!problem}
              title={
                problem ??
                (!online
                  ? "Backend offline. Open Settings to retry."
                  : "Compute a new Rust simulation for this template.")
              }
              onClick={() => onOpen(layout, name, "simulate")}
            >
              Run Simulation
            </button>
          </div>
          {problem && <p className="note">{problem}</p>}
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
                onClick={() => rename(custom)}
              >
                Rename
              </button>
              <button
                type="button"
                className="template-secondary"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete “${name}” from My Templates? Your current layout will stay unchanged.`,
                    )
                  )
                    persist(templates.filter((t) => t.id !== custom.id));
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </article>
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
            <strong>Save Current Layout</strong>
            <span>
              {building.width} × {building.height} m · Name your template
            </span>
          </button>
          {templates.map((template) =>
            card(template.name, template.building, template),
          )}
        </div>
      </section>
    </div>
  );
}
