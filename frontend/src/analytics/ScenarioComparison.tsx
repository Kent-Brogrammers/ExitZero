import { useState } from "react";
import type { SimulationMetrics, StressTestResult } from "../types/simulation";
import "./scenarioComparison.css";
import { scenarioTitle, outcomeExplanation } from "./presentation";

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
function difference(value: number, baseline: number) {
  const delta = value - baseline;
  return delta === 0
    ? "0 additional"
    : `${Math.abs(delta)} ${delta > 0 ? "more" : "fewer"}`;
}
export default function ScenarioComparison({
  result,
}: ScenarioComparisonProps) {
  const [selection, setSelection] = useState<{
    source: StressTestResult;
    id: string;
  } | null>(null);
  if (!result)
    return (
      <div className="empty-state compact">
        <h3>No scenarios evaluated</h3>
        <p>Run Stress Test to compare scenarios.</p>
      </div>
    );
  const scenarios = [...result.scenarios].sort((a, b) => a.rank - b.rank);
  const selected =
    (selection?.source === result
      ? scenarios.find((s) => s.scenario_id === selection.id)
      : undefined) ?? scenarios[0];
  return (
    <>
      <div
        className="scenario-scroll"
        tabIndex={0}
        role="region"
        aria-label="Scenario comparison table"
      >
        <table className="scenario-table">
          <caption>
            Baseline and stress scenarios. Rank 1 is most severe; ties may share
            a rank.
          </caption>
          <thead>
            <tr>
              {[
                "Rank",
                "Scenario",
                "Severity",
                "Status",
                "Evacuated",
                "Remaining",
                "Trapped",
                "Clearance",
              ].map((heading) => (
                <th scope="col" key={heading}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="baseline-row">
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
              <tr
                key={scenario.scenario_id}
                className={
                  selected?.scenario_id === scenario.scenario_id
                    ? "selected-row"
                    : undefined
                }
              >
                <td>{scenario.rank}</td>
                <th scope="row">
                  <button
                    type="button"
                    aria-pressed={
                      selected?.scenario_id === scenario.scenario_id
                    }
                    onClick={() =>
                      setSelection({ source: result, id: scenario.scenario_id })
                    }
                  >
                    {scenarioTitle(scenario)}
                  </button>
                </th>
                <td>
                  <span className={`severity severity-${scenario.severity}`}>
                    {scenario.severity}
                  </span>
                </td>
                <td>{statusLabel(scenario.metrics.status)}</td>
                <td>{scenario.metrics.evacuated}</td>
                <td>{scenario.metrics.remaining}</td>
                <td>{scenario.metrics.trapped}</td>
                <td>{clearanceLabel(scenario.metrics.clearance_steps)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">Baseline: {outcomeExplanation(result.baseline)}</p>
      {!scenarios.length && (
        <p>No stress scenarios were returned. Baseline metrics are shown.</p>
      )}
      {selected && (
        <section
          className="scenario-details"
          aria-label="Selected scenario details"
          aria-live="polite"
        >
          <h3>{scenarioTitle(selected)}</h3>
          <p>{selected.description}</p>
          <p>{outcomeExplanation(selected.metrics)}</p>
          <p>
            Rank {selected.rank} · {statusLabel(selected.metrics.status)}
          </p>
          <dl>
            <div>
              <dt>Evacuated</dt>
              <dd>
                {selected.metrics.evacuated} /{" "}
                {selected.metrics.total_population}
              </dd>
            </div>
            <div>
              <dt>Remaining</dt>
              <dd>{selected.metrics.remaining}</dd>
            </div>
            <div>
              <dt>Trapped</dt>
              <dd>{selected.metrics.trapped}</dd>
            </div>
            <div>
              <dt>Remaining vs. baseline</dt>
              <dd>
                {difference(
                  selected.metrics.remaining,
                  result.baseline.remaining,
                )}{" "}
                occupants
              </dd>
            </div>
            <div>
              <dt>Trapped vs. baseline</dt>
              <dd>
                {difference(selected.metrics.trapped, result.baseline.trapped)}{" "}
                occupants
              </dd>
            </div>
            <div>
              <dt>Clearance vs. baseline</dt>
              <dd>
                {selected.metrics.clearance_steps === null ||
                result.baseline.clearance_steps === null
                  ? "Unavailable: both runs need measured clearance"
                  : `${selected.metrics.clearance_steps - result.baseline.clearance_steps > 0 ? "+" : ""}${selected.metrics.clearance_steps - result.baseline.clearance_steps} steps`}
              </dd>
            </div>
          </dl>
          <p>
            <strong>Additional blocked exits:</strong>{" "}
            {selected.modifications.blocked_exit_ids.join(", ") || "None"}
          </p>
          <p>
            <strong>Added obstructions:</strong>{" "}
            {selected.modifications.added_obstructions.length
              ? selected.modifications.added_obstructions
                  .map(
                    (o) =>
                      `${o.id}: (${o.x}, ${o.y}) m, ${o.width} × ${o.height} m`,
                  )
                  .join("; ")
              : "None"}
          </p>
        </section>
      )}
      <p className="note">
        Trapped occupants are included in remaining occupants. Rankings and
        severity are supplied with the results. Scenario selection updates
        analytics only.
      </p>
    </>
  );
}
