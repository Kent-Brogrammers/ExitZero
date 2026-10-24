import type { SimulationResult } from "../types/simulation";

interface SimulationViewProps {
  result: SimulationResult | null;
}

export function SimulationView({ result }: SimulationViewProps) {
  // TODO(Developer 1): Canvas frame playback, timeline, and congestion overlays.
  return (
    <section
      className="panel"
      id="simulation"
      aria-labelledby="simulation-title"
    >
      <p className="eyebrow">02 / Simulation</p>
      <h2 id="simulation-title">Evacuation playback</h2>
      <div className="empty-state">
        <span className="empty-symbol" aria-hidden="true">
          ↗
        </span>
        <h3>
          {result
            ? `${result.frames.length} frames received`
            : "Ready for the engine"}
        </h3>
        <p>
          {result
            ? "Playback rendering is not implemented yet. See the metrics below."
            : "No simulation has run. Agent movement and playback will appear here when the engine is connected."}
        </p>
      </div>
    </section>
  );
}
