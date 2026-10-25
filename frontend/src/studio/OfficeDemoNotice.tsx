import type { SimulationResult } from "../types/simulation";
import { officeDemoProvenance } from "./officeDemo";
import "./OfficeDemo.css";

export type OfficeDemoSource = "recorded" | "edited" | "live";
export function OfficeDemoNotice({
  source,
  result,
  busy,
  onEdit,
  onReturn,
}: {
  source: OfficeDemoSource;
  result: SimulationResult | null;
  busy: boolean;
  onEdit: () => void;
  onReturn: () => void;
}) {
  return (
    <aside className="office-demo-notice" aria-label="Office demo information">
      <div className="office-demo-context">
        <strong>Office demo</strong>
        <span>
          {source === "recorded"
            ? `Precomputed Rust recording · ${officeDemoProvenance.recordedOn}`
            : source === "edited"
              ? "Layout edited · run a simulation for new results"
              : result
                ? "New Rust recording"
                : busy
                  ? "Live Rust simulation"
                  : "No completed recording · run again to retry"}
        </span>
        {result && (
          <span className="office-demo-outcome">
            {result.evacuated} / {result.total_population} evacuated ·{" "}
            {result.analytics?.simulated_seconds.toFixed(1) ?? "—"} s
          </span>
        )}
      </div>
      <div className="office-demo-actions">
        <button
          type="button"
          className="studio-control"
          disabled={busy}
          onClick={onEdit}
        >
          Edit layout
        </button>
        <button
          type="button"
          className="studio-control"
          disabled={busy}
          onClick={onReturn}
        >
          Return to your layout
        </button>
      </div>
      <div className="office-demo-explanation">
        {result && (
          <span
            className="office-demo-legend"
            aria-label="Relative recorded traffic from low to high"
          >
            Low <span className="office-demo-scale" aria-hidden="true" /> High
          </span>
        )}
        <span>
          {result
            ? "Relative recorded traffic. Full Analytics shows accumulated visits."
            : source === "live" && busy
              ? "Live positions from Rust. Playback and final analytics follow after the run."
              : "Run Simulation to compute traffic for this layout. The saved office recording does not describe these edits."}
        </span>
      </div>
    </aside>
  );
}
