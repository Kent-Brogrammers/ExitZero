import { useState } from "react";
import type {
  OptimizationCandidate,
  SimulationResult,
} from "../types/simulation";
import { LayoutCanvas } from "./LayoutCanvas";
import {
  clearanceLabel,
  openingChanges,
  type OptimizationEvaluation,
} from "./optimization";

export function OptimizationComparison({
  evaluation,
  onApply,
  disabled = false,
  rerun,
}: {
  evaluation: OptimizationEvaluation | null;
  onApply: (candidate: OptimizationCandidate) => void;
  disabled?: boolean;
  rerun: SimulationResult | null;
}) {
  const [selection, setSelection] = useState<{
    source: OptimizationEvaluation["result"];
    candidate: OptimizationCandidate;
  } | null>(null);
  if (!evaluation) return null;
  const { result, source, applied } = evaluation;
  const candidates = [...result.candidates].sort((a, b) => a.rank - b.rank);
  const selected =
    selection?.source === result ? selection.candidate : candidates[0];
  return (
    <section
      className="panel optimization-panel"
      aria-label="Layout optimization"
    >
      <p className="eyebrow">05 / Optimization</p>
      <h2>Layout improvements</h2>
      <p className="note">
        Measured against the layout used for this optimization. Rank 1 is best;
        ties may share a rank. Previewing keeps your edited building unchanged.
      </p>
      <div className="scenario-scroll">
        <table className="scenario-table">
          <caption>Baseline and computed improvements</caption>
          <thead>
            <tr>
              {[
                "Rank",
                "Modification",
                "Status",
                "Evacuated",
                "Remaining",
                "Trapped",
                "Clearance",
                "Preview",
              ].map((heading) => (
                <th key={heading} scope="col">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="baseline-row">
              <td>—</td>
              <th scope="row">Baseline</th>
              <td>{result.baseline.status}</td>
              <td>{result.baseline.evacuated}</td>
              <td>{result.baseline.remaining}</td>
              <td>{result.baseline.trapped}</td>
              <td>{clearanceLabel(result.baseline.clearance_steps)}</td>
              <td>—</td>
            </tr>
            {candidates.map((candidate, i) => (
              <tr
                key={i}
                className={selected === candidate ? "selected-row" : undefined}
              >
                <td>{candidate.rank}</td>
                <th scope="row">
                  {openingChanges(source, candidate.building).join("; ") ||
                    "Modified layout"}
                </th>
                <td>{candidate.metrics.status}</td>
                <td>{candidate.metrics.evacuated}</td>
                <td>{candidate.metrics.remaining}</td>
                <td>{candidate.metrics.trapped}</td>
                <td>{clearanceLabel(candidate.metrics.clearance_steps)}</td>
                <td>
                  <button
                    type="button"
                    aria-pressed={selected === candidate}
                    onClick={() => setSelection({ source: result, candidate })}
                  >
                    Preview candidate {i + 1}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!candidates.length && (
        <p>
          No strict improvement was found within the evaluation budget. Your
          layout is unchanged.
        </p>
      )}
      {selected && (
        <div className="optimization-preview">
          <h3>Candidate preview · rank {selected.rank}</h3>
          <p className="note">
            {openingChanges(source, selected.building).join("; ")}
          </p>
          <LayoutCanvas
            building={selected.building}
            label={`Candidate layout preview, rank ${selected.rank}`}
          />
          <button
            type="button"
            className="studio-control"
            disabled={disabled || applied === selected}
            onClick={() => onApply(selected)}
          >
            {applied === selected ? "Candidate applied" : "Apply candidate"}
          </button>
          <p className="note">
            Apply replaces the current layout with this candidate. Then use Run
            simulation to measure and play back the applied layout.
          </p>
        </div>
      )}
      {applied && (
        <p role="status">
          {rerun
            ? `Applied layout rerun: ${rerun.evacuated} / ${rerun.total_population} evacuated, ${rerun.remaining} remaining. ${clearanceLabel(rerun.clearance_steps)}. Original baseline: ${clearanceLabel(result.baseline.clearance_steps)}.`
            : "Candidate applied. Run simulation to verify the new layout."}
        </p>
      )}
    </section>
  );
}
