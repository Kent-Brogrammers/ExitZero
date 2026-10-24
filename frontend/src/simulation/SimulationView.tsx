import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { BuildingScenario, SimulationResult } from "../types/simulation";
import { createPlaybackRenderer } from "./drawPlayback";
import { createFrameSampler } from "./interpolation";
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
  const time = state.time;
  const firstTime = recording
    ? (frames[0]?.step ?? 0) * recording.time_step_seconds
    : 0;
  const sample = useMemo(
    () =>
      createFrameSampler(
        building,
        recording?.frames ?? [],
        recording?.time_step_seconds ?? 1,
      ),
    [building, recording],
  );
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
    const render = createPlaybackRenderer(element, building);
    const redraw = () =>
      render(sample(player.getTime()), window.devicePixelRatio);
    const unsubscribe = player.subscribeRender(redraw);
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(element);
    window.addEventListener("resize", redraw);
    return () => {
      unsubscribe();
      observer.disconnect();
      window.removeEventListener("resize", redraw);
    };
  }, [building, player, sample]);

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
      <div className="playback-stage">
        <div className="canvas-wrap playback-canvas-wrap">
          <canvas
            ref={canvas}
            width={1200}
            height={800}
            role="img"
            tabIndex={0}
            aria-keyshortcuts="Space ArrowLeft ArrowRight Home End"
            onKeyDown={(event) => {
              if (!active || !frame) return;
              if (
                [" ", "ArrowLeft", "ArrowRight", "Home", "End"].includes(
                  event.key,
                )
              ) {
                event.preventDefault();
                if (event.key === " ") {
                  if (state.playing) player.pause();
                  else player.play();
                } else if (event.key === "ArrowLeft") player.step(-1);
                else if (event.key === "ArrowRight") player.step(1);
                else player.seek(event.key === "Home" ? 0 : frames.length - 1);
              }
            }}
            aria-label={
              frame
                ? `Building layout with ${frame.agents.length} recorded occupants at recorded simulation step ${frame.step}. Visual interpolation is used between recorded frames.`
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
              className="play-button"
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
            <button
              type="button"
              aria-label="Previous recorded frame"
              title="Previous frame (← on Canvas)"
              disabled={!frame || state.index === 0}
              onClick={() => player.step(-1)}
            >
              ◀
            </button>
            <button
              type="button"
              aria-label="Next recorded frame"
              title="Next frame (→ on Canvas)"
              disabled={!frame || state.index >= frames.length - 1}
              onClick={() => player.step(1)}
            >
              ▶
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
        <div className="playback-bottomline">
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
                    / {finalTime.toFixed(2)} s (end)
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>Occupants (frame)</dt>
              <dd>{frame?.agents.length ?? "—"}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>
                <output aria-label="Recorded duration">
                  {frame ? `${(finalTime - firstTime).toFixed(2)} s` : "—"}
                </output>
              </dd>
            </div>
          </dl>
          <details className="recording-details">
            <summary>Recording details</summary>
            <div className="recording-popover">
              {frame && (
                <p className="note">
                  Recording starts at {firstTime.toFixed(2)} s.
                </p>
              )}
              {recording && (
                <p className="note">
                  Per-frame remaining and evacuated totals are not recorded.
                  Agent disappearance alone does not establish evacuation.
                </p>
              )}
              {recording && (
                <p className="playback-outcome">
                  Recorded outcome: <strong>{recording.status}</strong> ·{" "}
                  {recording.evacuated} / {recording.total_population} evacuated
                  · {recording.remaining} remaining ({recording.trapped}{" "}
                  unreachable).{" "}
                  {recording.status !== "completed" &&
                    "The evacuation did not complete; the recording ending does not imply success."}
                </p>
              )}
              <a className="playback-analytics-link" href="#analytics">
                Explore analytics ↗
              </a>

              <p className="note">
                Motion between recorded samples is visual only. Segments
                crossing barriers hold until the next sample; sparse recordings
                may jump.
              </p>
            </div>
          </details>
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
              Seek or step to pause · Space to play/pause · ←/→ to step with the
              Canvas focused
            </p>
          )}
        </div>
      </div>
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
