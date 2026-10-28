import { formatDimensions } from "../utils/units";
import { totalPopulation } from "../utils/population";
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
    <article
      className="template-card"
      data-halloween={building.pursuit ? "true" : undefined}
      aria-label={`${name} template`}
    >
      <TemplatePreview building={building} name={name} />
      <div className="template-card-content">
        <h3>{name}</h3>
        {building.pursuit && (
          <p className="templates-local-note">
            A masked stalker, blocked routes, and emergency windows. Edit the
            house or run a real seeded pursuit.
          </p>
        )}
        <p className="template-metadata">
          {formatDimensions(building.width, building.height)}{" "}
          <span aria-hidden="true">·</span> {totalPopulation(building)}{" "}
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
