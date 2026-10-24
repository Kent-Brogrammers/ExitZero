import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import mock from "../../../shared/examples/simulation.mock.json";
import type { SimulationResult, StressTestResult } from "../types/simulation";

interface AnalyticsDashboardProps {
  result: SimulationResult | null;
  stressResult: StressTestResult | null;
  showMock: boolean;
}

export default function AnalyticsDashboard({
  result,
  stressResult,
  showMock,
}: AnalyticsDashboardProps) {
  const metrics = showMock ? mock : result;
  const chart = metrics
    ? [
        { name: "Evacuated", occupants: metrics.evacuated },
        { name: "Remaining", occupants: metrics.remaining },
      ]
    : [];

  // TODO(Developer 4): traffic heatmap and ranked scenario comparison.
  return (
    <section className="analytics-grid" id="analytics" aria-label="Analytics">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">03 / Analytics</p>
            <h2>Evacuation metrics</h2>
          </div>
          <span className={`badge ${showMock ? "mock" : ""}`}>
            {showMock
              ? "MOCK DATA · separate 4 × 3 fixture"
              : result
                ? "API result"
                : "Awaiting results"}
          </span>
        </div>
        {metrics ? (
          <>
            <div className="metrics">
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
                    ? "Not cleared"
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
              {showMock
                ? "Synthetic UI fixture only. These numbers do not describe the displayed floor plan."
                : "Trapped occupants are a subset of remaining occupants."}
            </p>
          </>
        ) : (
          <div className="empty-state compact">
            <h3>No computed metrics</h3>
            <p>
              Run the engine when available, or enable the clearly labeled mock
              preview.
            </p>
          </div>
        )}
      </div>
      <div className="panel">
        <p className="eyebrow">04 / Stress testing</p>
        <h2>Vulnerability comparison</h2>
        <div className="empty-state compact">
          <h3>
            {stressResult
              ? `${stressResult.scenarios.length} scenarios received`
              : "No scenarios evaluated"}
          </h3>
          <p>
            Blocked-exit and obstruction analysis is not implemented. Rank by
            un-evacuated occupants before clearance time.
          </p>
        </div>
        <p className="note">
          Cell visits will represent accumulated traffic, not instantaneous
          crowd density.
        </p>
      </div>
    </section>
  );
}
