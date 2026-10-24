import { useState } from "react";
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

import ScenarioComparison from "./ScenarioComparison";
import { syntheticStressResult } from "./stressFixture";

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
  const [showStressPreview, setShowStressPreview] = useState(false);
  const metrics = showMock ? mock : result;
  const chart = metrics
    ? [
        { name: "Evacuated", occupants: metrics.evacuated },
        { name: "Remaining", occupants: metrics.remaining },
      ]
    : [];

  // TODO(Developer 4): world-coordinate traffic heatmap.
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
              ? "MOCK DATA · separate 4 × 3 m fixture"
              : result
                ? "API result"
                : "Awaiting results"}
          </span>
        </div>
        {metrics ? (
          <>
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
              Trapped occupants are included in remaining occupants.
              {showMock &&
                " Synthetic UI fixture only. These numbers do not describe the displayed floor plan."}
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
        <div className="stress-preview">
          <label>
            <input
              type="checkbox"
              checked={showStressPreview}
              onChange={(event) => setShowStressPreview(event.target.checked)}
            />
            Show synthetic stress-test preview
          </label>
          <span className={`badge ${showStressPreview ? "mock" : ""}`}>
            {showStressPreview
              ? "SYNTHETIC DATA · not computed"
              : stressResult
                ? "API stress-test results"
                : "Awaiting results"}
          </span>
        </div>
        {showStressPreview && (
          <p className="note">
            Illustrative results only. These scenarios and severity labels are
            invented examples and do not describe the displayed building. Turn
            off preview to view API results.
          </p>
        )}
        <ScenarioComparison
          result={showStressPreview ? syntheticStressResult : stressResult}
        />
        <p className="note">
          Traffic samples represent accumulated visits at world positions, not
          instantaneous crowd density.
        </p>
      </div>
    </section>
  );
}
