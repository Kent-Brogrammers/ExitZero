import { formatDimensions } from "../utils/units";
import type { ReactNode } from "react";
import type { BuildingScenario } from "../types/simulation";
import { buildingError } from "../editor/geometry";
import { TemplatePreview } from "./TemplatePreview";
import "./TemplatesPage.css";

export function TemplateCard({
  name,
  building,
  busy,
  online,
  onEdit,
  onRun,
  children,
}: {
  name: string;
  building: BuildingScenario;
  busy: boolean;
  online: boolean;
  onEdit: () => void;
  onRun: () => void;
  children?: ReactNode;
}) {
  const problem = buildingError(building);
  return (
    <article className="template-card" aria-label={`${name} template`}>
      <TemplatePreview building={building} name={name} />
      <div className="template-card-content">
        <h3>{name}</h3>
        <p className="template-metadata">
          {formatDimensions(building.width, building.height)}{" "}
          <span aria-hidden="true">·</span>{" "}
          {building.spawn_zones.reduce((count, zone) => count + zone.count, 0)}{" "}
          occupants
        </p>
        <div className="template-actions">
          <button
            type="button"
            className="studio-control template-card-edit"
            disabled={busy}
            title={`Open ${name} in the editor`}
            onClick={onEdit}
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
            onClick={onRun}
          >
            Run Simulation
          </button>
        </div>
        {problem && <p className="note">{problem}</p>}
        {children}
      </div>
    </article>
  );
}
