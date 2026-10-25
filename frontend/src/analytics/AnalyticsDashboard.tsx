import type {
  BuildingScenario,
  OptimizationCandidate,
  SimulationResult,
  StressTestResult,
} from "../types/simulation";

import { PopulationChart } from "./PopulationChart";
import { OptimizationComparison } from "./OptimizationComparison";
import type { OptimizationEvaluation } from "./optimization";

import ScenarioComparison from "./ScenarioComparison";
import TrafficHeatmap from "./TrafficHeatmap";
import CrowdingRanking from "./CrowdingRanking";
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
  return (
    <section className="analytics-grid" id="analytics" aria-label="Analytics">
      <div className="panel">
        <div className="panel-heading">
          <div>
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
                Metrics use the simulation run; comparisons use the computed
                stress-test baseline.
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
            <p>Run Simulation to see results.</p>
          </div>
        )}
      </div>
      <TrafficHeatmap building={building} result={result} />
      <CrowdingRanking building={building} result={result} />
      <div className="panel comparison-panel">
        <h2>Vulnerability comparison</h2>
        <ScenarioComparison result={stressResult} />
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
