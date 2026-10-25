import { useState } from "react";
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
import {
  outcomeExplanation,
  scenarioTitle,
  clearanceChange,
} from "./presentation";
import { openingChanges } from "./optimization";
import { LayoutComparison } from "./LayoutComparison";
import type { BaselineRecording } from "./comparison";

interface AnalyticsDashboardProps {
  onViewInSimulation?: (step: number) => void;
  result: SimulationResult | null;
  stressResult: StressTestResult | null;
  building?: BuildingScenario;
  optimization?: OptimizationEvaluation | null;
  onApply?: (candidate: OptimizationCandidate) => void;
  disabled?: boolean;
  onStress?: () => void;
  onOptimize?: () => void;
  onWatchScenario?: (id: string) => void;
  baseline?: BaselineRecording | null;
  onWatchOriginal?: () => void;
}

export default function AnalyticsDashboard({
  onViewInSimulation,
  result,
  stressResult,
  building,
  optimization = null,
  onApply,
  disabled,
  onStress,
  onOptimize,
  onWatchScenario,
  baseline,
  onWatchOriginal,
}: AnalyticsDashboardProps) {
  const [view, setView] = useState<"overview" | "advanced">("overview");
  const metrics = result ?? stressResult?.baseline ?? null;
  const worst = stressResult?.scenarios.toSorted((a, b) => a.rank - b.rank)[0];
  const best = optimization?.result.candidates.toSorted(
    (a, b) => a.rank - b.rank,
  )[0];
  const timeStep = result?.time_step_seconds ?? building?.time_step_seconds;
  return (
    <section id="analytics" aria-label="Analytics">
      <div className="control-buttons" role="group" aria-label="Analytics view">
        <button
          aria-pressed={view === "overview"}
          onClick={() => setView("overview")}
        >
          Overview
        </button>
        <button
          aria-pressed={view === "advanced"}
          onClick={() => setView("advanced")}
        >
          Advanced
        </button>
      </div>
      <div className="analytics-grid" hidden={view !== "overview"}>
        <section className="panel" aria-label="Outcome overview">
          <h2>What happened?</h2>
          <span className="badge">
            {result
              ? "Computed simulation"
              : stressResult
                ? "Computed stress-test baseline"
                : "Awaiting results"}
          </span>
          {metrics ? (
            <>
              <p>{outcomeExplanation(metrics, result?.termination_reason)}</p>
              <div className="metrics">
                <div>
                  <span>Evacuated</span>
                  <strong>
                    {metrics.evacuated} / {metrics.total_population}
                  </strong>
                </div>
                <div>
                  <span>Sheltered</span>
                  <strong>{metrics.sheltered ?? 0}</strong>
                </div>
                <div title="Still inside when the run ended; not a death count.">
                  <span>Remaining</span>
                  <strong>{metrics.remaining}</strong>
                </div>
                <div title="Only a completed run measures full clearance.">
                  <span>
                    {metrics.clearance_steps === null
                      ? "Elapsed simulated time"
                      : "Measured clearance"}
                  </span>
                  <strong>
                    {metrics.clearance_steps !== null
                      ? `${metrics.clearance_steps} steps${timeStep ? ` / ${(metrics.clearance_steps * timeStep).toFixed(2)} s` : ""}`
                      : result?.analytics
                        ? `${result.analytics.simulated_seconds.toFixed(2)} s`
                        : "Unavailable"}
                  </strong>
                </div>
              </div>
              {result?.analytics && building?.disaster && (
                <p>
                  Injured during run:{" "}
                  <strong>
                    {
                      result.analytics.agents.filter((a) => (a.injury ?? 0) > 0)
                        .length
                    }
                  </strong>
                </p>
              )}
              <p className="note">
                Remaining means still inside when the run ended. Deaths are not
                modeled.
              </p>
              <details>
                <summary>Outcome and opening-state evidence</summary>
                {result?.analytics && building?.disaster && (
                  <p title="Occupants with any recorded injury during the run; this count can include evacuated occupants.">
                    Injured during run:{" "}
                    {
                      result.analytics.agents.filter((a) => (a.injury ?? 0) > 0)
                        .length
                    }
                    . Injury and hazard exposure are distinct from remaining or
                    trapped status. Deaths are not modeled.
                  </p>
                )}
                {!!result?.frames.at(-1)?.blocked_opening_ids?.length && (
                  <p>
                    Blocked openings in the final recorded state:{" "}
                    {result.frames.at(-1)!.blocked_opening_ids!.join(", ")}.
                    Inspect playback for the timing; this list alone does not
                    establish why each occupant remained.
                  </p>
                )}
                <p className="note">
                  Remaining occupants are not presumed dead. Trapped is a
                  narrower engine classification; zero trapped does not prove an
                  available escape route.
                </p>
              </details>
            </>
          ) : (
            <p>
              Run a live simulation or Calculate Results to measure this layout.
            </p>
          )}
        </section>
        <section className="panel" aria-label="Vulnerability overview">
          <h2>What went wrong?</h2>
          {worst && stressResult ? (
            <>
              <h3>{scenarioTitle(worst)}</h3>
              <p>
                Most disruptive tested scenario · {worst.severity} severity ·{" "}
                {worst.metrics.remaining} remaining (
                {worst.metrics.remaining - stressResult.baseline.remaining >= 0
                  ? "+"
                  : ""}
                {worst.metrics.remaining - stressResult.baseline.remaining}{" "}
                versus baseline).
              </p>
              <p>
                Clearance change:{" "}
                {clearanceChange(
                  stressResult.baseline.clearance_steps,
                  worst.metrics.clearance_steps,
                  timeStep,
                )}
              </p>
              <button onClick={() => setView("advanced")}>
                Inspect scenario evidence
              </button>
            </>
          ) : stressResult ? (
            <p>The requested test returned no modified scenarios.</p>
          ) : (
            <>
              <p>
                Stress testing has not been run for this layout. Test exit
                closures to find vulnerabilities.
              </p>
              {onStress && (
                <button disabled={disabled} onClick={onStress}>
                  Run stress test
                </button>
              )}
            </>
          )}
        </section>
        <section className="panel" aria-label="Improvement overview">
          <h2>What can we improve?</h2>
          {best && optimization ? (
            <>
              <p>
                {openingChanges(optimization.source, best.building).join("; ")}
              </p>
              <p>
                Clearance change:{" "}
                {clearanceChange(
                  optimization.result.baseline.clearance_steps,
                  best.metrics.clearance_steps,
                  timeStep,
                )}
              </p>
              <p className="note">
                This improves the optimizer's baseline objective. Run stress
                testing again to measure failure resilience.
              </p>
              <button onClick={() => setView("advanced")}>
                Review recommendation
              </button>
            </>
          ) : optimization ? (
            <p>No strict improvement was found within this candidate budget.</p>
          ) : (
            <>
              <p>
                Optimization has not been run. Evaluate permitted opening
                widenings against the baseline.
              </p>
              {onOptimize && (
                <button disabled={disabled} onClick={onOptimize}>
                  Find improvements
                </button>
              )}
            </>
          )}
        </section>
      </div>
      {view === "advanced" && (
        <div className="analytics-grid">
          <div className="panel">
            <div className="panel-heading">
              <div>
                <h2>
                  {building?.disaster?.kind === "tornado"
                    ? "Shelter response metrics"
                    : "Evacuation metrics"}
                </h2>
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
                <p className="note">
                  {outcomeExplanation(metrics, result?.termination_reason)}
                </p>
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
                    <span title="Occupants still inside when the run ended; includes trapped occupants.">
                      Remaining
                    </span>
                    <strong>{metrics.remaining}</strong>
                  </div>
                  <div>
                    <span>Evacuated</span>
                    <strong>
                      {metrics.evacuated} / {metrics.total_population}
                    </strong>
                  </div>
                  {(metrics.sheltered ?? 0) > 0 && (
                    <div>
                      <span>Sheltered</span>
                      <strong>{metrics.sheltered}</strong>
                    </div>
                  )}
                  {building?.disaster && (
                    <div>
                      <span>Injured during run</span>
                      <strong>
                        {result?.analytics?.agents.filter(
                          (a) => (a.injury ?? 0) > 0,
                        ).length ?? "—"}
                      </strong>
                    </div>
                  )}
                  <div>
                    <span title="Remaining occupants when all exits are explicitly blocked and no eligible window or tornado shelter applies.">
                      Trapped
                    </span>
                    <strong>{metrics.trapped}</strong>
                  </div>
                  <div>
                    <span title="Full clearance requires everyone to evacuate or reach a designated tornado shelter.">
                      Clearance
                    </span>
                    <strong>
                      {metrics.clearance_steps === null
                        ? "No measured clearance"
                        : `${metrics.clearance_steps} steps`}
                    </strong>
                  </div>
                </div>
                <details>
                  <summary>Population breakdown</summary>
                  <PopulationChart metrics={metrics} />
                </details>
                <p className="note">
                  Trapped occupants are included in remaining occupants. The
                  engine only counts trapped occupants when every exit is
                  explicitly blocked.
                </p>
              </>
            ) : (
              <div className="empty-state compact">
                <h3>No computed metrics</h3>
                <p>Run Simulation to see results.</p>
              </div>
            )}
          </div>
          <details className="panel">
            <summary>Traffic and peak crowding</summary>
            <TrafficHeatmap building={building} result={result} />
            <CrowdingRanking
              building={building}
              result={result}
              onViewInSimulation={onViewInSimulation}
            />
          </details>
          <div className="panel comparison-panel">
            <h2>Vulnerability comparison</h2>
            <ScenarioComparison
              result={stressResult}
              onWatch={onWatchScenario}
              disabled={disabled}
              timeStep={timeStep}
            />
          </div>
          {onApply && (
            <OptimizationComparison
              evaluation={optimization}
              onApply={onApply}
              disabled={disabled}
              rerun={result}
            />
          )}
        </div>
      )}
      {baseline && building && (
        <LayoutComparison
          before={baseline}
          building={building}
          result={result}
          onWatchOriginal={onWatchOriginal}
        />
      )}
    </section>
  );
}
