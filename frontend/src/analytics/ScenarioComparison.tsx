import type { SimulationMetrics, StressTestResult } from "../types/simulation";

interface ScenarioComparisonProps {
  result: StressTestResult | null;
}

function statusLabel(status: SimulationMetrics["status"]) {
  if (status === "completed") return "Completed";
  if (status === "timeout") return "Step limit reached";
  return "Incomplete";
}

function clearanceLabel(steps: number | null) {
  return steps === null ? "No measured clearance" : `${steps} steps`;
}

export default function ScenarioComparison({
  result,
}: ScenarioComparisonProps) {
  if (!result) {
    return (
      <div className="empty-state compact">
        <h3>No scenarios evaluated</h3>
        <p>Run a stress test when the backend is available.</p>
      </div>
    );
  }

  const scenarios = [...result.scenarios].sort(
    (first, second) => first.rank - second.rank,
  );

  return (
    <div
      style={{ overflowX: "auto" }}
      tabIndex={0}
      role="region"
      aria-label="Scenario comparison table"
    >
      <table>
        <caption>Baseline and stress scenarios. Rank 1 is most severe.</caption>
        <thead>
          <tr>
            <th scope="col">Rank</th>
            <th scope="col">Scenario</th>
            <th scope="col">Severity</th>
            <th scope="col">Status</th>
            <th scope="col">Evacuated</th>
            <th scope="col">Remaining</th>
            <th scope="col">Trapped</th>
            <th scope="col">Clearance</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>—</td>
            <th scope="row">Baseline</th>
            <td>—</td>
            <td>{statusLabel(result.baseline.status)}</td>
            <td>{result.baseline.evacuated}</td>
            <td>{result.baseline.remaining}</td>
            <td>{result.baseline.trapped}</td>
            <td>{clearanceLabel(result.baseline.clearance_steps)}</td>
          </tr>
          {scenarios.map((scenario) => (
            <tr key={scenario.scenario_id}>
              <td>{scenario.rank}</td>
              <th scope="row">{scenario.description}</th>
              <td>{scenario.severity}</td>
              <td>{statusLabel(scenario.metrics.status)}</td>
              <td>{scenario.metrics.evacuated}</td>
              <td>{scenario.metrics.remaining}</td>
              <td>{scenario.metrics.trapped}</td>
              <td>{clearanceLabel(scenario.metrics.clearance_steps)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {scenarios.length === 0 && (
        <p>No stress scenarios were returned. Baseline metrics are shown.</p>
      )}
      <p className="note">
        Trapped occupants are included in remaining occupants.
      </p>
    </div>
  );
}
