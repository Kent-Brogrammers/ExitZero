import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { BuildingScenario, SimulationResult } from "../types/simulation";
import { drawPlayback } from "./drawPlayback";
import { createPlayback, PLAYBACK_SPEEDS } from "./playback";
import { syntheticBuilding, syntheticResult } from "./playback.fixture";
import "./SimulationView.css";

interface SimulationViewProps {
  building: BuildingScenario;
  result: SimulationResult | null;
  active?: boolean;
}

function Playback({ building, result, active = true }: SimulationViewProps) {
  const mismatch =
    result !== null &&
    (result.width !== building.width || result.height !== building.height);
  const recording = mismatch ? null : result;
  const player = useMemo(() => createPlayback(recording), [recording]);
  const state = useSyncExternalStore(
    player.subscribe,
    player.getSnapshot,
    player.getSnapshot,
  );
  const canvas = useRef<HTMLCanvasElement>(null);
  const frames = recording?.frames ?? [];
  const frame = frames[state.index] ?? null;
  const time =
    frame && recording ? frame.step * recording.time_step_seconds : 0;
  const finalTime = recording
    ? (frames.at(-1)?.step ?? 0) * recording.time_step_seconds
    : 0;
  const atEnd = frames.length > 1 && state.index === frames.length - 1;

  useEffect(() => () => player.dispose(), [player]);
  useEffect(() => {
    if (!active) player.pause();
  }, [active, player]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const redraw = () =>
      drawPlayback(element, building, frame, window.devicePixelRatio);
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(element);
    window.addEventListener("resize", redraw);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", redraw);
    };
  }, [building, frame]);

  const status = state.playing
    ? "Playing"
    : atEnd
      ? "End of recording"
      : frames.length === 1
        ? "Single recorded frame"
        : state.started
          ? "Paused"
          : "Ready";
  return (
    <div className="playback-workspace">
      <aside className="playback-rail" aria-label="Playback view">
        <span className="playback-view-icon" aria-hidden="true">
          ▷
        </span>
        <strong>Recording</strong>
        <span>Read only</span>
      </aside>
      <div className="playback-stage">
        <div className="canvas-wrap playback-canvas-wrap">
          <canvas
            ref={canvas}
            width={1200}
            height={800}
            role="img"
            aria-label={
              frame
                ? `Building layout with ${frame.agents.length} recorded occupants at simulation step ${frame.step}.`
                : "Building layout. No recorded occupants to display."
            }
          />
          <div className="canvas-caption">
            <span>
              {building.width} × {building.height} m ·{" "}
              {recording ? "Recording layout" : "Current layout"}
            </span>
            <span>{frames.length} recorded frames</span>
          </div>
        </div>
        <div className="playback-transport">
          <div
            className="playback-controls"
            role="group"
            aria-label="Playback controls"
          >
            <button
              type="button"
              className="primary"
              disabled={frames.length < 2 || state.playing}
              onClick={player.play}
            >
              {atEnd ? "Replay" : state.started ? "Resume" : "Play"}
            </button>
            <button
              type="button"
              disabled={!state.playing}
              onClick={player.pause}
            >
              Pause
            </button>
            <button type="button" disabled={!frame} onClick={player.reset}>
              Reset
            </button>
            <label className="playback-speed">
              Speed
              <select
                aria-label="Playback speed"
                disabled={!frame}
                value={state.speed}
                onChange={(event) =>
                  player.setSpeed(Number(event.target.value))
                }
              >
                {PLAYBACK_SPEEDS.map((speed) => (
                  <option key={speed} value={speed}>
                    {speed}×
                  </option>
                ))}
              </select>
            </label>
            <span className="playback-status" role="status">
              {frame ? status : "No frames"}
            </span>
          </div>
          <div className="playback-timeline">
            <label htmlFor="playback-seek">Recording timeline</label>
            <input
              id="playback-seek"
              type="range"
              min={0}
              max={Math.max(0, frames.length - 1)}
              step={1}
              value={state.index}
              disabled={frames.length < 2}
              aria-valuetext={
                frame
                  ? `Frame ${state.index + 1} of ${frames.length}, step ${frame.step}, ${time.toFixed(2)} seconds`
                  : "No frames"
              }
              onChange={(event) =>
                player.seek(event.currentTarget.valueAsNumber)
              }
            />
            <span>
              {frame
                ? `Frame ${state.index + 1} / ${frames.length}`
                : "No recorded frames"}
            </span>
          </div>
        </div>
        <div className="playback-help">
          {mismatch ? (
            <p className="playback-error" role="alert">
              This recording's dimensions do not match the current layout. Run a
              new simulation for this building.
            </p>
          ) : !recording ? (
            <p className="note">
              No simulation has run. The current layout is shown. Run a
              simulation or enable the synthetic preview to try playback.
            </p>
          ) : !frames.length ? (
            <p className="note">
              The result contains no animation frames. Playback controls are
              unavailable.
            </p>
          ) : (
            <p className="note">
              Seeking pauses playback. Positions and time shown belong to the
              selected recorded frame.
            </p>
          )}
        </div>
      </div>
      <aside className="playback-inspector" aria-label="Simulation inspector">
        <p className="eyebrow">Recording</p>
        <h3>Simulation details</h3>
        <dl className="playback-readout">
          <div>
            <dt>Simulation step</dt>
            <dd>
              <output aria-label="Current simulation step" aria-live="off">
                {frame?.step ?? "—"}
              </output>
            </dd>
          </div>
          <div>
            <dt>Simulation time</dt>
            <dd>
              <output aria-label="Elapsed simulation time" aria-live="off">
                {frame ? `${time.toFixed(2)} s` : "—"}
              </output>
              {frame && (
                <span className="playback-duration">
                  {" "}
                  / {finalTime.toFixed(2)} s
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Visible occupants</dt>
            <dd>{frame?.agents.length ?? "—"}</dd>
          </div>
        </dl>
        {recording && (
          <p className="playback-outcome">
            Recorded outcome: <strong>{recording.status}</strong> ·{" "}
            {recording.evacuated} / {recording.total_population} evacuated ·{" "}
            {recording.remaining} remaining ({recording.trapped} unreachable).{" "}
            {recording.status !== "completed" &&
              "The evacuation did not complete; the recording ending does not imply success."}
          </p>
        )}
        <a className="playback-analytics-link" href="#analytics">
          Explore analytics ↗
        </a>
      </aside>
    </div>
  );
}

export function SimulationView({
  building,
  result,
  active = true,
}: SimulationViewProps) {
  const [preview, setPreview] = useState(false);
  // A newly returned API result takes precedence over a development preview.
  useEffect(() => {
    setPreview(false);
  }, [result]);

  return (
    <section
      className="panel simulation-panel"
      id="simulation"
      aria-labelledby="simulation-title"
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">02 / Simulation</p>
          <h2 id="simulation-title">Evacuation playback</h2>
        </div>
      </div>
      <div className="playback-source">
        <label className="playback-preview-toggle">
          <input
            type="checkbox"
            checked={preview}
            onChange={(event) => setPreview(event.target.checked)}
          />
          Use synthetic playback preview
        </label>
        <span className={`badge${preview ? " mock" : ""}`}>
          {preview
            ? "SYNTHETIC PREVIEW"
            : result
              ? "API recording"
              : "Awaiting simulation"}
        </span>
      </div>
      {preview && (
        <p className="playback-synthetic-note" role="note">
          Scripted development fixture only. No simulation was run. This shows a
          separate 4 × 3 m layout with two occupants; it does not represent your
          edited building or feed the analytics dashboard.
        </p>
      )}
      <Playback
        active={active}
        building={preview ? syntheticBuilding : building}
        result={preview ? syntheticResult : result}
      />
    </section>
  );
}
