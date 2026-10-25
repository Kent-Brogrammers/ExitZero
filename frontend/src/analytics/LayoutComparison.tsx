import type { BuildingScenario, SimulationResult } from "../types/simulation";
import { comparisonContext, type BaselineRecording } from "./comparison";
import { clearanceChange } from "./presentation";
import { LayoutCanvas } from "./LayoutCanvas";

export function LayoutComparison({
  before,
  building,
  result,
  onWatchOriginal,
  showLayouts = false,
}: {
  before: BaselineRecording;
  building: BuildingScenario;
  result: SimulationResult | null;
  onWatchOriginal?: () => void;
  showLayouts?: boolean;
}) {
  const context = result ? comparisonContext(before, building, result) : null;
  const clearance = (run: SimulationResult) =>
    run.clearance_steps === null
      ? "No measured clearance"
      : `${run.clearance_steps} steps / ${(run.clearance_steps * run.time_step_seconds).toFixed(2)} s`;
  return (
    <section
      className="panel layout-comparison"
      aria-label="Original and modified comparison"
    >
      <h2>Did the change help?</h2>
      <p className="note">
        The original recording is preserved independently of the edited layout.
      </p>
      {onWatchOriginal && (
        <button onClick={onWatchOriginal}>Watch original recording</button>
      )}
      {!result ? (
        <p>Run the modified layout to compare actual outcomes.</p>
      ) : (
        <>
          <p>
            Geometry:{" "}
            {context!.changes.join("; ") ||
              "No wall, opening, or obstruction change detected."}
          </p>
          {context!.differences.length ? (
            <p role="status">
              Comparability limitations: {context!.differences.join("; ")}.
              These outcomes are separate experiments; a change in clearance is
              not attributed to layout alone.
            </p>
          ) : (
            <p>
              Seed, population, hazard/settings, and starting occupant positions
              match. Geometry is the measured change.
            </p>
          )}
          <table className="scenario-table">
            <caption>Actual original and modified outcomes</caption>
            <thead>
              <tr>
                <th>Metric</th>
                <th>Original</th>
                <th>Modified</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>Status</th>
                <td>{before.result.status}</td>
                <td>{result.status}</td>
              </tr>
              <tr>
                <th>Evacuated</th>
                <td>{before.result.evacuated}</td>
                <td>{result.evacuated}</td>
              </tr>
              <tr>
                <th>Sheltered</th>
                <td>{before.result.sheltered ?? 0}</td>
                <td>{result.sheltered ?? 0}</td>
              </tr>
              <tr>
                <th>Remaining</th>
                <td>{before.result.remaining}</td>
                <td>{result.remaining}</td>
              </tr>
              <tr>
                <th>Clearance</th>
                <td>{clearance(before.result)}</td>
                <td>{clearance(result)}</td>
              </tr>
            </tbody>
          </table>
          {!context!.differences.length && (
            <p>
              Clearance change:{" "}
              {clearanceChange(
                before.result.clearance_steps,
                result.clearance_steps,
                result.time_step_seconds,
              )}
            </p>
          )}
          {showLayouts ? (
            <section aria-label="Compare layout geometry">
              <h3>Compare layout geometry</h3>
              <div className="analytics-grid">
                <LayoutCanvas
                  building={before.building}
                  label="Original layout geometry"
                />
                <LayoutCanvas
                  building={building}
                  label="Modified layout geometry"
                />
              </div>
            </section>
          ) : (
            <details>
              <summary>Compare layout geometry</summary>
              <div className="analytics-grid">
                <LayoutCanvas
                  building={before.building}
                  label="Original layout geometry"
                />
                <LayoutCanvas
                  building={building}
                  label="Modified layout geometry"
                />
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
