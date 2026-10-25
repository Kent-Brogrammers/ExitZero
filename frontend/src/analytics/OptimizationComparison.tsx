import { useState } from "react";
import type {
  OptimizationCandidate,
  SimulationResult,
} from "../types/simulation";
import { LayoutCanvas } from "./LayoutCanvas";
import {
  clearanceLabel,
  openingChanges,
  improvementLabel,
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
    selection?.source === result && candidates.includes(selection.candidate)
      ? selection.candidate
      : candidates[0];
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
      <div className="optimization-baseline">
        <span>Original baseline</span>
        <strong>
          {clearanceLabel(result.baseline.clearance_steps)}
          {result.baseline.clearance_steps !== null &&
            ` / ${(result.baseline.clearance_steps * source.time_step_seconds).toFixed(2)} s`}
        </strong>
        <span>
          {result.baseline.status} · {result.baseline.evacuated} /{" "}
          {result.baseline.total_population} evacuated ·{" "}
          {result.baseline.remaining} remaining · {result.baseline.trapped}{" "}
          trapped
        </span>
      </div>
      {!candidates.length ? (
        <p className="note optimization-empty">
          No strict improvement was found within the evaluation budget. Your
          layout is unchanged.
        </p>
      ) : (
        <div className="optimization-split">
          <div className="optimization-recommendations">
            <h3>
              Ranked recommendations <span>{candidates.length}</span>
            </h3>
            <p className="note">
              Select a recommendation to inspect its geometry. Arrow keys move
              through the list.
            </p>
            <div
              className="optimization-candidates"
              role="listbox"
              aria-label="Optimization recommendations"
              onKeyDown={(event) => {
                if (
                  !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                )
                  return;
                event.preventDefault();
                const current = Math.max(0, candidates.indexOf(selected!));
                const index =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? candidates.length - 1
                      : Math.max(
                          0,
                          Math.min(
                            candidates.length - 1,
                            current + (event.key === "ArrowDown" ? 1 : -1),
                          ),
                        );
                setSelection({ source: result, candidate: candidates[index]! });
                const option =
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="option"]',
                  )[index];
                option?.focus({ preventScroll: true });
                option?.scrollIntoView?.({ block: "nearest" });
              }}
            >
              {candidates.map((candidate, index) => (
                <button
                  key={index}
                  type="button"
                  role="option"
                  aria-selected={selected === candidate}
                  aria-label={`Recommendation ${index + 1}, rank ${candidate.rank}: ${openingChanges(source, candidate.building).join("; ") || "Modified layout"}`}
                  tabIndex={selected === candidate ? 0 : -1}
                  className="optimization-candidate"
                  onClick={() => setSelection({ source: result, candidate })}
                >
                  <span className="optimization-candidate-heading">
                    <span className="optimization-rank">
                      Rank {candidate.rank}
                    </span>
                    <strong>
                      {clearanceLabel(candidate.metrics.clearance_steps)}
                    </strong>
                  </span>
                  <span className="optimization-change">
                    {openingChanges(source, candidate.building).join("; ") ||
                      "Modified layout"}
                  </span>
                  <span className="optimization-improvement">
                    {improvementLabel(
                      result.baseline,
                      candidate.metrics,
                      source.time_step_seconds,
                    )}
                  </span>
                  <span className="optimization-candidate-outcome">
                    {candidate.metrics.status} · {candidate.metrics.evacuated} /{" "}
                    {candidate.metrics.total_population} evacuated ·{" "}
                    {candidate.metrics.remaining} remaining ·{" "}
                    {candidate.metrics.trapped} trapped
                  </span>
                </button>
              ))}
            </div>
          </div>
          {selected && (
            <div
              className="optimization-preview"
              aria-label="Selected recommendation"
            >
              <div className="optimization-preview-heading">
                <div>
                  <p className="eyebrow">SELECTED RECOMMENDATION</p>
                  <h3>Candidate preview · rank {selected.rank}</h3>
                </div>
                <span className="badge">Editor unchanged</span>
              </div>
              <p className="note">
                {openingChanges(source, selected.building).join("; ")}
              </p>
              <div className="optimization-geometry-legend">
                <span className="proposed-opening">
                  Solid: proposed opening
                </span>
                <span className="original-opening">
                  Dashed: original opening
                </span>
              </div>
              <LayoutCanvas
                building={selected.building}
                comparisonBuilding={source}
                label={`Candidate layout preview, rank ${selected.rank}`}
              />
              <p className="optimization-preview-improvement">
                {improvementLabel(
                  result.baseline,
                  selected.metrics,
                  source.time_step_seconds,
                )}
              </p>
              <div className="scenario-scroll optimization-metrics">
                <table className="scenario-table">
                  <caption>Original and selected candidate outcomes</caption>
                  <thead>
                    <tr>
                      <th>Outcome</th>
                      <th>Baseline</th>
                      <th>Selected</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th>Status</th>
                      <td>{result.baseline.status}</td>
                      <td>{selected.metrics.status}</td>
                    </tr>
                    <tr>
                      <th>Evacuated</th>
                      <td>{result.baseline.evacuated}</td>
                      <td>{selected.metrics.evacuated}</td>
                    </tr>
                    <tr>
                      <th>Remaining / trapped</th>
                      <td>
                        {result.baseline.remaining} / {result.baseline.trapped}
                      </td>
                      <td>
                        {selected.metrics.remaining} /{" "}
                        {selected.metrics.trapped}
                      </td>
                    </tr>
                    {((result.baseline.sheltered ?? 0) > 0 ||
                      (selected.metrics.sheltered ?? 0) > 0) && (
                      <tr>
                        <th>Sheltered</th>
                        <td>{result.baseline.sheltered ?? 0}</td>
                        <td>{selected.metrics.sheltered ?? 0}</td>
                      </tr>
                    )}
                    <tr>
                      <th>Clearance</th>
                      <td>{clearanceLabel(result.baseline.clearance_steps)}</td>
                      <td>
                        {clearanceLabel(selected.metrics.clearance_steps)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <button
                type="button"
                className="studio-control optimization-apply"
                disabled={disabled || applied === selected}
                onClick={() => onApply(selected)}
              >
                {applied === selected ? "Candidate applied" : "Apply candidate"}
              </button>
              <p className="note">
                Only Apply changes the editor. Rerun the applied layout to
                measure it; baseline improvements do not establish better
                stress-test performance.
              </p>
            </div>
          )}
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
