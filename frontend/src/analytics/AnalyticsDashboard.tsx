import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type {
  BuildingScenario,
  SimulationResult,
  StressTestResult,
} from "../types/simulation";

import ScenarioComparison from "./ScenarioComparison";
import TrafficHeatmap from "./TrafficHeatmap";
import { outcomeExplanation } from "./presentation";

interface AnalyticsDashboardProps {
  building?: BuildingScenario;
  result: SimulationResult | null;
  stressResult: StressTestResult | null;
}

export default function AnalyticsDashboard({
  building,
  result,
  stressResult,
}: AnalyticsDashboardProps) {
  const metrics = result ?? stressResult?.baseline ?? null;
  const chart = metrics
    ? [
        { name: "Evacuated", occupants: metrics.evacuated },
        { name: "Remaining", occupants: metrics.remaining },
      ]
    : [];

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
            <div
              className="chart"
              role="img"
              aria-label={`${metrics.evacuated} evacuated and ${metrics.remaining} remaining. Trapped occupants are included in remaining.`}
            >
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart
                  data={chart}
                  margin={{ top: 12, right: 12, bottom: 0, left: -24 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} />
                  <YAxis
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip />
                  <Bar
                    dataKey="occupants"
                    fill="#347d69"
                    radius={[4, 4, 0, 0]}
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
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
      <TrafficHeatmap building={building} result={result} />
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
    </section>
  );
}
