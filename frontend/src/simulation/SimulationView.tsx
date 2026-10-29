import { createAgentEffects } from "./agentEffects";
import { formatDimensions } from "../utils/units";
import { snapshotFrameIndex, type ReplayTarget } from "./replayTarget";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  BuildingScenario,
  LiveSimulation,
  LiveSpeedControl,
  SimulationResult,
} from "../types/simulation";
import { LiveSimulationView } from "./LiveSimulationView";
import { createPlaybackRenderer, drawAgents } from "./drawPlayback";
import { drawLayout } from "../editor/draw";
import { canvasPalette } from "../styles/canvasPalette";
import { trafficField, fieldPixels } from "../analytics/trafficField";
import { createRecordedTrails } from "./recordedTrails";
import { frameIndexAtTime } from "./playback";
import { useStudioTheme } from "../styles/appearance";
import { createFrameSampler } from "./interpolation";
import { createPlayback, PLAYBACK_SPEEDS } from "./playback";
import { syntheticBuilding, syntheticResult } from "./playback.fixture";
import { SimulationSummary } from "./SimulationSummary";
import { frameLayout } from "./frameLayout";
import { SimulationDetails } from "./SimulationDetails";
import { AgentChat } from "./AgentChat";
import { outcomeExplanation } from "../analytics/presentation";
import { StudioPopover } from "../ui/StudioPopover";
import {
  defaultDisplayOptions,
  type SimulationDisplayOptions,
} from "./displayOptions";
import { RecordingExport } from "./ExportRecording";
import { PursuitMetrics } from "./PursuitMetrics";
import "./SimulationView.css";

interface SimulationViewProps {
  building: BuildingScenario;
  result: SimulationResult | null;
  live?: LiveSimulation | null;
  replayTarget?: ReplayTarget | null;
  active?: boolean;
  allowSyntheticPreview?: boolean;
  onOpenAnalytics?: () => void;
  onLiveSpeedChange?: (speed: LiveSpeedControl["speed"]) => void;
  onCancelLive?: () => void;
}

interface PlaybackProps extends SimulationViewProps {
  displayOptions: SimulationDisplayOptions;
  synthetic: boolean;
  analyticsOpen: boolean;
  onCloseAnalytics: () => void;
  showAgentNumbers: boolean;
  showAgentChat: boolean;
  onCloseChat: () => void;
}

function Playback({
  building,
  replayTarget,
  result,
  active = true,
  allowSyntheticPreview = true,
  synthetic,
  analyticsOpen,
  onCloseAnalytics,
  onOpenAnalytics,
  showAgentNumbers,
  showAgentChat,
  onCloseChat,
  displayOptions,
}: PlaybackProps) {
  const theme = useStudioTheme();

  const mismatch =
    result !== null &&
    (result.width !== building.width || result.height !== building.height);
  const recording = mismatch ? null : result;
  const player = useMemo(() => {
    const playback = createPlayback(recording);
    // A real run has already been watched live. Begin its review at the end.
    if (recording && !synthetic) playback.seek(recording.frames.length - 1);
    return playback;
  }, [recording, synthetic]);
  const state = useSyncExternalStore(
    player.subscribe,
    player.getSnapshot,
    player.getSnapshot,
  );
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!replayTarget || replayTarget.source !== recording || !recording)
      return;
    const index = snapshotFrameIndex(recording, replayTarget.step);
    if (index < 0) return;
    player.pause();
    player.seek(index);
    if (replayTarget.play) player.play();
    canvas.current?.focus({ preventScroll: true });
  }, [replayTarget, recording, player]);
  const frames = recording?.frames ?? [];
  const finalFrame = frames.at(-1);
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
    if (!active || !element) return;
    const render = createPlaybackRenderer(
      element,
      building,
      undefined,
      displayOptions,
    );
    const palette = canvasPalette(element);
    const effects = createAgentEffects([
      ...(recording?.communication_events ?? []),
      ...(recording?.agent_events ?? []),
    ]);
    const trailSampler =
      recording && displayOptions.showTraffic
        ? createRecordedTrails(recording)
        : null;
    const finalData =
      recording && trailSampler
        ? trailSampler(recording.frames.length - 1)
        : null;
    const finalPeak =
      finalData && recording
        ? trafficField(finalData, recording.width, recording.height, 0.6).peak
        : 0;
    trailSampler?.(0);
    const layer = document.createElement("canvas");
    let lastIndex = -1;
    const redraw = () => {
      const time = player.getTime();
      const agents = sample(time);
      const ratio = window.devicePixelRatio || 1;
      if (!recording || !trailSampler) {
        render(agents, ratio, showAgentNumbers);
        effects(element, building, agents, time, ratio);
        return;
      }
      const index = frameIndexAtTime(
        recording.frames,
        recording.time_step_seconds,
        time,
      );
      if (index !== lastIndex) {
        const field = trafficField(
          trailSampler(index),
          recording.width,
          recording.height,
          0.6,
        );
        layer.width = field.columns;
        layer.height = field.rows;
        const ctx = layer.getContext("2d");
        if (ctx) {
          const pixels = ctx.createImageData(field.columns, field.rows);
          pixels.data.set(fieldPixels({ ...field, peak: finalPeak }));
          ctx.putImageData(pixels, 0, 0);
        }
        lastIndex = index;
      }
      drawLayout(
        element,
        frameLayout(building, agents),
        null,
        undefined,
        ratio,
        palette,
        {
          windowStates: agents?.window_states,
          disasterState: agents?.disaster_state,
          ...displayOptions,
          showPursuitStart: false,
          showPlacedOccupants: !agents,
          underlay: (ctx) => {
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, building.width, building.height);
            ctx.clip();
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(layer, 0, 0, building.width, building.height);
            ctx.restore();
          },
        },
      );
      drawAgents(element, building, agents, ratio, palette, showAgentNumbers);
      effects(element, building, agents, time, ratio);
    };
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
  }, [
    building,
    player,
    sample,
    theme,
    recording,
    showAgentNumbers,
    displayOptions,
    active,
  ]);

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
    <div
      className={`playback-workspace${analyticsOpen ? " has-analytics" : ""}`}
    >
      <div className="playback-stage">
        <div className="canvas-wrap playback-canvas-wrap">
          {showAgentChat && (
            <AgentChat
              building={building}
              result={recording}
              time={time}
              onClose={onCloseChat}
            />
          )}
          <canvas
            data-world-canvas
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
              {formatDimensions(building.width, building.height)} ·{" "}
              {recording ? "Recording layout" : "Current layout"}
            </span>
            <span>{frames.length} recorded frames</span>
          </div>
        </div>
        <div className="playback-dock">
          <div className="playback-transport">
            <div
              className="playback-controls"
              role="group"
              aria-label="Playback controls"
            >
              <button
                type="button"
                className="studio-control play-button"
                disabled={frames.length < 2 || state.playing}
                onClick={player.play}
              >
                {atEnd ? "Replay" : state.started ? "Resume" : "Play"}
              </button>
              <button
                type="button"
                className="studio-control"
                disabled={!state.playing}
                onClick={player.pause}
              >
                Pause
              </button>
              <button
                type="button"
                className="studio-control"
                disabled={!frame}
                onClick={player.reset}
              >
                Reset
              </button>
              <button
                type="button"
                className="studio-control studio-control--icon"
                aria-label="Previous recorded frame"
                title="Previous frame (← on Canvas)"
                disabled={!frame || state.index === 0}
                onClick={() => player.step(-1)}
              >
                ◀
              </button>
              <button
                type="button"
                className="studio-control studio-control--icon"
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
                  className="studio-control"
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
              <RecordingExport
                building={building}
                result={recording}
                synthetic={synthetic}
                active={active}
                showAgentNumbers={showAgentNumbers}
                onOpen={player.pause}
              />
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
                <dt>Elapsed time</dt>
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
              {frame?.pursuit ? (
                <PursuitMetrics frame={frame} final={atEnd} />
              ) : (
                <>
                  <div>
                    <dt>
                      {building.disaster?.kind === "tornado"
                        ? "Sheltered (final)"
                        : "Evacuated (final)"}
                    </dt>
                    <dd>
                      {building.disaster?.kind === "tornado"
                        ? (recording?.sheltered ?? "—")
                        : (recording?.evacuated ?? "—")}
                      {building.disaster?.kind !== "tornado" &&
                        (recording?.sheltered ?? 0) > 0 && (
                          <> · {recording!.sheltered} sheltered</>
                        )}
                    </dd>
                  </div>
                  <div>
                    <dt>Remaining (final)</dt>
                    <dd>{recording?.remaining ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Status (final)</dt>
                    <dd role="status">
                      {recording
                        ? recording.status === "completed"
                          ? "Completed"
                          : recording.status === "timeout"
                            ? "Step limit reached"
                            : "Incomplete"
                        : "Awaiting simulation"}
                    </dd>
                  </div>
                </>
              )}
            </dl>
            {recording && (
              <SimulationDetails
                building={building}
                states={frame?.window_states}
              >
                <section
                  className="simulation-detail-section"
                  aria-label="Recording information"
                >
                  <h4>Recording</h4>
                  <p>
                    {finalFrame?.pursuit
                      ? finalFrame.agents.length
                        ? "The pursuit reached its step limit with survivors still active."
                        : "The pursuit finished: every survivor escaped or was caught."
                      : outcomeExplanation(
                          recording,
                          recording.termination_reason,
                        )}
                  </p>
                  <p>
                    Blocked openings at the playhead:{" "}
                    {frame?.blocked_opening_ids?.join(", ") || "None recorded"}.
                    Closure marks remain visible when labels are hidden.
                  </p>
                  <dl className="playback-readout">
                    <div>
                      <dt>Simulation step</dt>
                      <dd>
                        <output
                          aria-label="Current simulation step"
                          aria-live="off"
                        >
                          {frame?.step ?? "—"}
                        </output>
                      </dd>
                    </div>
                    <div>
                      <dt>Recorded occupants</dt>
                      <dd>{frame?.agents.length ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Duration</dt>
                      <dd>
                        <output aria-label="Recorded duration">
                          {frame
                            ? `${(finalTime - firstTime).toFixed(2)} s`
                            : "—"}
                        </output>
                      </dd>
                    </div>
                    <div>
                      <dt>Playback</dt>
                      <dd>{frame ? status : "No frames"}</dd>
                    </div>
                  </dl>
                  {frame && (
                    <p className="note">
                      Recording starts at {firstTime.toFixed(2)} s.
                    </p>
                  )}
                  {recording && (
                    <p className="note">
                      Outcome counts and status describe the final result, not
                      the playhead. Agent disappearance alone does not establish
                      evacuation.
                    </p>
                  )}
                  {recording && !finalFrame?.pursuit && (
                    <p className="playback-outcome">
                      Recorded outcome: <strong>{recording.status}</strong> ·{" "}
                      {recording.evacuated} / {recording.total_population}{" "}
                      evacuated · {recording.sheltered ?? 0} sheltered ·{" "}
                      {recording.remaining} remaining ({recording.trapped}{" "}
                      trapped).{" "}
                      {recording.status !== "completed" &&
                        "Recording ended before full evacuation."}
                    </p>
                  )}
                  {finalFrame?.pursuit && (
                    <dl className="playback-readout">
                      <PursuitMetrics frame={finalFrame} final />
                    </dl>
                  )}
                  <a
                    className="studio-control playback-analytics-link"
                    href="#analytics"
                    onClick={(event) => {
                      if (onOpenAnalytics) {
                        event.preventDefault();
                        onOpenAnalytics();
                      }
                    }}
                  >
                    Open Analytics ↗
                  </a>

                  <p className="note">
                    Motion between recorded samples is visual only. Segments
                    crossing barriers hold until the next sample; sparse
                    recordings may jump.
                  </p>
                  <p className="note">
                    Seek or step to pause · Space to play/pause · ←/→ to step
                    with the Canvas focused
                  </p>
                </section>
                <section
                  className="simulation-detail-section"
                  aria-label="Recorded traffic trails"
                >
                  <h4>Recorded traffic trails</h4>
                  <p className="note">
                    Accumulates sampled positions as playback advances. Pause
                    freezes trails; reset clears them; seeking rebuilds them.
                    Colors use a fixed scale for this recording. These
                    observations are not the backend's full accumulated traffic
                    totals.
                  </p>
                </section>
              </SimulationDetails>
            )}
          </div>
          <div className="playback-help">
            {mismatch ? (
              <p className="playback-error" role="alert">
                This recording's dimensions do not match the current layout. Run
                a new simulation for this building.
              </p>
            ) : !recording ? (
              <p className="note">
                No recording yet. Run Simulation
                {allowSyntheticPreview ? " or try the synthetic preview." : "."}
              </p>
            ) : !frames.length ? (
              <p className="note">
                No recorded frames. Playback is unavailable.
              </p>
            ) : null}
          </div>
        </div>
      </div>
      {analyticsOpen && (
        <SimulationSummary
          result={recording}
          synthetic={synthetic}
          playheadTime={frame ? time : null}
          onClose={onCloseAnalytics}
          onOpenAnalytics={onOpenAnalytics}
        />
      )}
    </div>
  );
}

export function SimulationView({
  building,
  result,
  replayTarget,
  live = null,
  active = true,
  allowSyntheticPreview = true,
  onOpenAnalytics,
  onLiveSpeedChange,
  onCancelLive,
}: SimulationViewProps) {
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [showAgentNumbers, setShowAgentNumbers] = useState(false);
  const [displayOptions, setDisplayOptions] = useState(defaultDisplayOptions);
  const [showAgentChat, setShowAgentChat] = useState(false);
  const chatToggle = useRef<HTMLInputElement>(null);
  const analyticsButton = useRef<HTMLButtonElement>(null);
  function closeAnalytics() {
    setAnalyticsOpen(false);
    analyticsButton.current?.focus();
  }
  function closeChat() {
    setShowAgentChat(false);
    chatToggle.current?.focus();
  }
  const [previewRequested, setPreview] = useState(false);
  const preview = previewRequested && allowSyntheticPreview;
  const running = live !== null;
  // A newly returned API result takes precedence over a development preview.
  useEffect(() => {
    setPreview(false);
  }, [result, running, replayTarget]);

  return (
    <section
      className="panel simulation-panel"
      id="simulation"
      aria-labelledby="simulation-title"
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">02 / Simulation</p>
          <h2 id="simulation-title">
            {live?.status === "cancelled"
              ? "Cancelled evacuation"
              : live
                ? "Live evacuation"
                : "Evacuation playback"}
          </h2>
        </div>
      </div>
      <div className="playback-source">
        <div className="playback-source-info">
          <label className="playback-preview-toggle">
            <input
              type="checkbox"
              checked={preview}
              disabled={live !== null || !allowSyntheticPreview}
              onChange={(event) => setPreview(event.target.checked)}
            />
            Use synthetic playback preview
          </label>
          <span className={`badge${preview ? " mock" : ""}`}>
            {live?.status === "cancelled"
              ? "CANCELLED"
              : live
                ? "LIVE · RECORDING"
                : preview
                  ? "SYNTHETIC PREVIEW"
                  : result
                    ? "API recording"
                    : "Awaiting simulation"}
          </span>
          <label className="playback-preview-toggle">
            <input
              type="checkbox"
              checked={showAgentNumbers}
              onChange={(event) => setShowAgentNumbers(event.target.checked)}
            />
            Show Agent Numbers
          </label>
          <StudioPopover label="Display">
            {() => (
              <fieldset>
                <legend>Simulation display</legend>
                <label>
                  Hazard rendering{" "}
                  <select
                    aria-label="Hazard rendering"
                    value={displayOptions.hazardMode}
                    onChange={(event) =>
                      setDisplayOptions({
                        ...displayOptions,
                        hazardMode: event.target
                          .value as SimulationDisplayOptions["hazardMode"],
                      })
                    }
                  >
                    <option value="filled">Filled region</option>
                    <option value="outline">Outline</option>
                    <option value="both">Both</option>
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={displayOptions.showBlockedLabels}
                    onChange={(event) =>
                      setDisplayOptions({
                        ...displayOptions,
                        showBlockedLabels: event.target.checked,
                      })
                    }
                  />
                  Show blocked-opening labels
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={displayOptions.showTraffic}
                    onChange={(event) =>
                      setDisplayOptions({
                        ...displayOptions,
                        showTraffic: event.target.checked,
                      })
                    }
                  />
                  Show traffic overlay
                </label>
                <p className="note">
                  Closed openings retain their cross marks. Open Details for
                  opening IDs. Display options do not change the simulation.
                </p>
              </fieldset>
            )}
          </StudioPopover>
          <label
            className="playback-preview-toggle"
            title={
              running && !building.pursuit
                ? "Available after the recording finishes"
                : undefined
            }
          >
            <input
              ref={chatToggle}
              type="checkbox"
              checked={showAgentChat}
              disabled={running && !building.pursuit}
              aria-controls="agent-chat"
              onChange={(event) => setShowAgentChat(event.target.checked)}
            />
            Show Agent Chat
          </label>
          {building.pursuit && !preview && (
            <span className="pursuit-legend">
              Halloween pursuit · Orange: survivors · Red mask: stalker · Red ×:
              caught
            </span>
          )}
        </div>
        <button
          ref={analyticsButton}
          type="button"
          className="studio-control"
          aria-expanded={analyticsOpen}
          aria-controls="simulation-summary"
          disabled={live !== null}
          onClick={() => setAnalyticsOpen(!analyticsOpen)}
        >
          {analyticsOpen ? "Hide Analytics" : "Show Analytics"}
        </button>
      </div>
      {preview && !live && (
        <p className="playback-synthetic-note" role="note">
          Synthetic preview: two occupants in a separate{" "}
          {formatDimensions(4, 3)} layout. No simulation was run for your
          building. Full Analytics uses API results.
        </p>
      )}
      {live ? (
        <LiveSimulationView
          building={building}
          live={live}
          onSpeedChange={onLiveSpeedChange}
          onCancel={onCancelLive}
          active={active}
          showAgentNumbers={showAgentNumbers}
          showAgentChat={showAgentChat}
          onChatOpenChange={setShowAgentChat}
          displayOptions={displayOptions}
        />
      ) : (
        <Playback
          synthetic={preview}
          displayOptions={displayOptions}
          replayTarget={replayTarget}
          allowSyntheticPreview={allowSyntheticPreview}
          analyticsOpen={analyticsOpen}
          onCloseAnalytics={closeAnalytics}
          onOpenAnalytics={onOpenAnalytics}
          showAgentNumbers={showAgentNumbers}
          showAgentChat={showAgentChat}
          onCloseChat={closeChat}
          active={active}
          building={preview ? syntheticBuilding : building}
          result={preview ? syntheticResult : result}
        />
      )}
    </section>
  );
}
