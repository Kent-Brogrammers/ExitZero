import type {
  BuildingScenario,
  OptimizationCandidate,
  SimulationResult,
  StressTestResult,
} from "../types/simulation";

import { LayoutCanvas } from "./LayoutCanvas";
import { PopulationChart } from "./PopulationChart";
import { OptimizationComparison } from "./OptimizationComparison";
import type { OptimizationEvaluation } from "./optimization";
import { trafficCells } from "./traffic";

import ScenarioComparison from "./ScenarioComparison";
import { outcomeExplanation } from "./presentation";

interface AnalyticsDashboardProps {
  result: SimulationResult | null;
  stressResult: StressTestResult | null;
  building?: BuildingScenario;
  optimization?: OptimizationEvaluation | null;
  onApply?: (candidate: OptimizationCandidate) => void;
  disabled?: boolean;
}

export default function AnalyticsDashboard({
  result,
  stressResult,
  building,
  optimization = null,
  onApply,
  disabled,
}: AnalyticsDashboardProps) {
  const metrics = result ?? stressResult?.baseline ?? null;
  const cells = result
    ? trafficCells(result.traffic_samples, result.width, result.height)
    : [];
  const peak = cells.reduce(
    (maximum, cell) => Math.max(maximum, cell.visits),
    0,
  );
  return (
    <section className="analytics-grid" id="analytics" aria-label="Analytics">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">03 / Analytics</p>
            <h2>Evacuation metrics</h2>
          </div>
          <span className="badge">
            {result
              ? "Computed simulation"
              : stressResult
                ? "Computed stress-test baseline"
                : "Awaiting results"}
          </span>
        </div>
        {metrics ? (
          <>
            <p className="note">{outcomeExplanation(metrics)}</p>
            {result && stressResult && (
              <p className="note">
                These cards show the standalone simulation. The comparison below
                uses its own computed stress-test baseline.
              </p>
            )}
            <div className="metrics">
              <div>
                <span>Status</span>
                <strong>
                  {metrics.status === "completed"
                    ? "Completed"
                    : metrics.status === "timeout"
                      ? "Step limit reached"
                      : "Incomplete"}
                </strong>
              </div>
              <div>
                <span>Remaining</span>
                <strong>{metrics.remaining}</strong>
              </div>
              <div>
                <span>Evacuated</span>
                <strong>
                  {metrics.evacuated} / {metrics.total_population}
                </strong>
              </div>
              <div>
                <span>Trapped</span>
                <strong>{metrics.trapped}</strong>
              </div>
              <div>
                <span>Clearance</span>
                <strong>
                  {metrics.clearance_steps === null
                    ? "No measured clearance"
                    : `${metrics.clearance_steps} steps`}
                </strong>
              </div>
            </div>
            <PopulationChart metrics={metrics} />
            <p className="note">
              Trapped occupants are included in remaining occupants. The engine
              only counts trapped occupants when every exit is explicitly
              blocked.
            </p>
          </>
        ) : (
          <div className="empty-state compact">
            <h3>No computed metrics</h3>
            <p>
              Run a simulation for the current building to see computed metrics.
            </p>
          </div>
        )}
      </div>
      <div className="panel" aria-label="Traffic heatmap">
        <p className="eyebrow">Traffic / Accumulated visits</p>
        <h2>Traffic heatmap</h2>
        {result && building ? (
          <>
            <LayoutCanvas
              building={building}
              samples={result.traffic_samples}
              label={`Traffic heatmap for the standalone simulation. ${result.traffic_samples.length} recorded samples; peak ${peak} visits per bin.`}
            />
            {cells.length ? (
              <div className="traffic-scale">
                <span>Low visits</span>
                <span>Peak: {peak} visits / bin</span>
              </div>
            ) : (
              <p>No traffic samples were recorded.</p>
            )}
            <p className="note">
              Positioned in metres and weighted by accumulated visits from the
              standalone simulation. This is not instantaneous crowd density or
              a recording of the selected stress scenario.
            </p>
          </>
        ) : (
          <p className="note">
            Run a simulation to record traffic for the current layout.
          </p>
        )}
      </div>
      <div className="panel comparison-panel">
        <p className="eyebrow">04 / Stress testing</p>
        <h2>Vulnerability comparison</h2>
        <p className="note">
          Run Stress test to compute a baseline and blocked-exit scenarios for
          the current building.
        </p>
        <ScenarioComparison result={stressResult} />
        <p className="note">
          Traffic samples represent accumulated visits at world positions, not
          instantaneous crowd density.
        </p>
      </div>
      {onApply && (
        <OptimizationComparison
          evaluation={optimization}
          onApply={onApply}
          disabled={disabled}
          rerun={result}
        />
      )}
    </section>
  );
}
