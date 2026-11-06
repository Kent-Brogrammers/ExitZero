import { createAgentEffects } from "./agentEffects";
import { CanvasScale } from "../editor/CanvasScale";
import { totalPopulation } from "../utils/population";
import { useEffect, useMemo, useRef, useState } from "react";
import { SimulationDetails } from "./SimulationDetails";
import { AgentChat } from "./AgentChat";
import { appendChat, chatSummaryMessage } from "./communication";
import { formatDimensions } from "../utils/units";
import { useDisplayUnits } from "../utils/useDisplayUnits";
import { PursuitMetrics } from "./PursuitMetrics";
import { AgentInspector, AgentPicker } from "./AgentInspector";
import {
  agentTrail,
  drawAgentInspection,
  pickAgent,
  type AgentTrailPoint,
} from "./agentInspection";
import type {
  AnimationFrame,
  BuildingScenario,
  LiveSimulation,
  LiveSpeedControl,
} from "../types/simulation";
import { useStudioTheme } from "../styles/appearance";
import { drawAgents } from "./drawPlayback";
import { drawLayout } from "../editor/draw";
import { canvasPalette } from "../styles/canvasPalette";
import {
  trafficField,
  congestionPixels,
  CONGESTION_RED_REFERENCE_SECONDS,
} from "../analytics/trafficField";
import { congestionBins } from "../analytics/traffic";
import { frameCrowding } from "../analytics/crowding";

import { createFrameSampler } from "./interpolation";
import { frameLayout } from "./frameLayout";
import {
  defaultDisplayOptions,
  type SimulationDisplayOptions,
} from "./displayOptions";

export function LiveSimulationView({
  building,
  live,
  active,
  showAgentNumbers = false,
  showAgentChat,
  onChatOpenChange,
  onSpeedChange,
  onCancel,
  displayOptions = defaultDisplayOptions,
}: {
  building: BuildingScenario;
  live: LiveSimulation;
  active: boolean;
  showAgentNumbers?: boolean;
  showAgentChat: boolean;
  onChatOpenChange: (open: boolean) => void;
  onSpeedChange?: (speed: LiveSpeedControl["speed"]) => void;
  onCancel?: () => void;
  displayOptions?: SimulationDisplayOptions;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useStudioTheme();
  const units = useDisplayUnits();
  const population = totalPopulation(building);
  const agentIds = useMemo(
    () => Array.from({ length: population }, (_, id) => id),
    [population],
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const shownFrame = useRef<AnimationFrame | null>(null);
  const trail = useRef<{
    building: BuildingScenario;
    id: number | null;
    previous: AnimationFrame | null;
    points: AgentTrailPoint[];
  }>({ building, id: null, previous: null, points: [] });
  useEffect(() => {
    const frame = live.frame;
    if (
      trail.current.building !== building ||
      (frame &&
        trail.current.previous &&
        frame.step < trail.current.previous.step)
    ) {
      trail.current = { building, id: null, previous: null, points: [] };
      setSelectedId(null);
      return;
    }
    if (trail.current.id !== selectedId) {
      trail.current = { building, id: selectedId, previous: null, points: [] };
    }
    if (
      selectedId === null ||
      !frame ||
      frame.step === trail.current.previous?.step
    )
      return;
    const frames = trail.current.previous
      ? [trail.current.previous, frame]
      : [frame];
    const point = agentTrail(building, frames, selectedId).at(-1);
    if (point?.step === frame.step) {
      trail.current.points = [...trail.current.points, point].slice(-2000);
    }
    trail.current.previous = frame;
  }, [building, live.frame, selectedId]);
  const cancelled = live.status === "cancelled";
  const speed = live.speed ?? 1;
  const nextSpeed = speed === 1 ? 2 : speed === 2 ? 4 : speed === 4 ? 8 : 1;
  const [readThrough, setReadThrough] = useState(0);
  const chatButton = useRef<HTMLButtonElement>(null);
  const chat = live.frame?.pursuit
    ? appendChat(
        undefined,
        live.frame.pursuit.events ?? [],
        building.time_step_seconds,
      )
    : (live.chat ?? { messages: [], total: 0 });
  const unread = showAgentChat ? 0 : Math.max(0, chat.total - readThrough);
  const lastMessage = chat.messages.at(-1);
  function closeChat() {
    setReadThrough(chat.total);
    onChatOpenChange(false);
    chatButton.current?.focus();
  }

  const effects = useRef(createAgentEffects([]));
  useEffect(() => {
    effects.current = createAgentEffects(
      live.effect_events ?? [],
      live.agent_modifiers,
    );
  }, [live.effect_events, live.agent_modifiers]);
  const heatLayer = useRef<HTMLCanvasElement | null>(null);
  const latest = useRef<{
    frame: AnimationFrame | null;
    sample: ReturnType<typeof createFrameSampler> | null;
    fromTime: number;
    receivedAt: number;
  }>({ frame: null, sample: null, fromTime: 0, receivedAt: 0 });

  useEffect(() => {
    if (displayOptions.showTraffic) {
      const data = congestionBins(
        live.congestion_samples ?? [],
        building.width,
        building.height,
      );
      const field = trafficField(data, building.width, building.height, 0.6);
      const layer = heatLayer.current ?? document.createElement("canvas");
      layer.width = field.columns;
      layer.height = field.rows;
      const ctx = layer.getContext("2d");
      if (ctx) {
        const pixels = ctx.createImageData(field.columns, field.rows);
        pixels.data.set(
          congestionPixels(
            field,
            (live.frame?.step ?? 0) * building.time_step_seconds,
          ),
        );
        ctx.putImageData(pixels, 0, 0);
      }
      heatLayer.current = layer;
    } else heatLayer.current = null;
    const frame = live.frame;
    const previous =
      latest.current.frame && frame && latest.current.frame.step < frame.step
        ? latest.current.frame
        : null;
    latest.current = {
      frame,
      sample: frame
        ? createFrameSampler(
            building,
            previous ? [previous, frame] : [frame],
            building.time_step_seconds,
          )
        : null,
      fromTime:
        (previous?.step ?? frame?.step ?? 0) * building.time_step_seconds,
      receivedAt: performance.now(),
    };
  }, [
    building,
    live.frame,
    live.congestion_samples,
    displayOptions.showTraffic,
  ]);

  useEffect(() => {
    if (!active || !canvas.current) return;
    const target = canvas.current;
    const palette = canvasPalette(target);
    let animation = 0;
    function tick(now: number) {
      const snapshot = latest.current;
      const seconds = cancelled
        ? (snapshot.frame?.step ?? 0) * building.time_step_seconds
        : Math.min(
            (snapshot.frame?.step ?? 0) * building.time_step_seconds,
            snapshot.fromTime + ((now - snapshot.receivedAt) / 1000) * speed,
          );
      const frame = cancelled
        ? snapshot.frame
        : (snapshot.sample?.(seconds) ?? null);
      shownFrame.current = frame;
      // Interpolate only between physics samples already received. The live
      // view never predicts future positions or needs the run's duration.
      drawLayout(
        target,
        frameLayout(building, frame),
        null,
        undefined,
        window.devicePixelRatio || 1,
        palette,
        {
          windowStates: frame?.window_states,
          disasterState: frame?.disaster_state,
          showPursuitStart: false,
          showPlacedOccupants: !frame,
          ...displayOptions,
          underlay: displayOptions.showTraffic
            ? (ctx) => {
                const layer = heatLayer.current;
                if (!layer) return;
                ctx.save();
                ctx.beginPath();
                ctx.rect(0, 0, building.width, building.height);
                ctx.clip();
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(layer, 0, 0, building.width, building.height);
                ctx.restore();
              }
            : undefined,
        },
      );
      drawAgents(
        target,
        building,
        frame,
        window.devicePixelRatio || 1,
        palette,
        showAgentNumbers,
      );
      effects.current(
        target,
        building,
        frame,
        seconds,
        window.devicePixelRatio || 1,
      );
      drawAgentInspection(
        target,
        building,
        frame,
        selectedId,
        trail.current.points,
        seconds / building.time_step_seconds,
        palette,
      );
      animation = requestAnimationFrame(tick);
    }
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [
    active,
    building,
    theme,
    units,
    showAgentNumbers,
    speed,
    cancelled,
    displayOptions,
    selectedId,
  ]);

  const frame = live.frame;
  return (
    <div className="playback-workspace">
      <div className="playback-stage">
        <div className="canvas-wrap playback-canvas-wrap">
          {selectedId !== null && (
            <AgentInspector
              id={selectedId}
              building={building}
              frame={frame}
              events={live.effect_events}
              modifierRecording={live.agent_modifiers}
              live
              onClose={() => {
                setSelectedId(null);
                canvas.current?.focus({ preventScroll: true });
              }}
            />
          )}
          <canvas
            data-world-canvas
            ref={canvas}
            width={1200}
            height={800}
            role="img"
            tabIndex={0}
            title="Click an occupant to inspect their statistics and sampled path"
            onClick={(event) => {
              if (!active) return;
              setSelectedId(
                pickAgent(
                  event.currentTarget,
                  building,
                  shownFrame.current ?? frame,
                  { x: event.clientX, y: event.clientY },
                  showAgentNumbers,
                ),
              );
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSelectedId(null);
            }}
            aria-label={
              frame
                ? `${cancelled ? "Cancelled" : "Live"} evacuation at step ${frame.step}, ${frame.agents.length} occupants remaining.`
                : cancelled
                  ? "Evacuation cancelled before the first frame."
                  : "Preparing the live evacuation."
            }
          />
          {displayOptions.showScale !== false && (
            <CanvasScale canvas={canvas} building={building} />
          )}
          <div className="canvas-caption">
            <span>{formatDimensions(building.width, building.height)}</span>
            <span>
              {cancelled
                ? "Cancelled"
                : frame
                  ? building.disaster
                    ? `Alarm: ${building.disaster.kind.replace("_", " ")} · live`
                    : building.pursuit
                      ? "Halloween — The Pursuit · live"
                      : "Live · recording"
                  : "Preparing simulation…"}
            </span>
          </div>
        </div>
        <div className="playback-dock">
          <div className="live-run-controls">
            <AgentPicker
              ids={frame ? agentIds : []}
              selected={selectedId}
              onSelect={setSelectedId}
            />
            <button
              type="button"
              className="studio-control"
              disabled={
                cancelled || !frame || live.speed_pending || !onSpeedChange
              }
              aria-label={`Live speed ${speed}×. Switch to ${nextSpeed}×`}
              onClick={() => onSpeedChange?.(nextSpeed)}
            >
              {live.speed_pending ? "Changing speed…" : `Speed: ${speed}×`}
            </button>
            <button
              type="button"
              className="studio-control live-cancel-button"
              disabled={cancelled || !onCancel}
              onClick={onCancel}
            >
              {cancelled ? "Cancelled" : "Cancel run"}
            </button>
          </div>
          {live.control_error && (
            <p className="playback-error" role="alert">
              {live.control_error}
            </p>
          )}
          <div className="playback-bottomline">
            <dl className="playback-readout">
              <div>
                <dt>Elapsed simulation time</dt>
                <dd>
                  {frame
                    ? `${(frame.step * building.time_step_seconds).toFixed(2)} s`
                    : "—"}
                </dd>
              </div>
              {frame?.pursuit ? (
                <PursuitMetrics frame={frame} />
              ) : (
                <>
                  <div>
                    <dt>Remaining</dt>
                    <dd>{frame?.agents.length ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>
                      {building.disaster?.kind === "tornado"
                        ? "Sheltered"
                        : "Evacuated"}
                    </dt>
                    <dd>
                      {frame
                        ? building.disaster?.kind === "tornado"
                          ? (frame.sheltered ?? 0)
                          : population -
                            frame.agents.length -
                            (frame.sheltered ?? 0)
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd role="status">
                      {cancelled
                        ? "Cancelled"
                        : frame
                          ? `Live · ${speed}×`
                          : "Starting…"}
                    </dd>
                  </div>
                </>
              )}
            </dl>
            {frame && (
              <SimulationDetails
                building={building}
                states={frame.window_states}
              >
                <section
                  className="simulation-detail-section"
                  aria-label="Live crowding"
                >
                  <h4>Live crowding</h4>
                  <p>
                    Blocked openings:{" "}
                    {frame.blocked_opening_ids?.join(", ") || "None recorded"}.
                    Closure marks stay visible when labels are hidden.
                  </p>
                  <p className="note">
                    Current busiest zone:{" "}
                    {Math.max(
                      0,
                      ...frameCrowding(
                        frame,
                        building.width,
                        building.height,
                      ).map((spot) => spot.count),
                    )}{" "}
                    occupants in a {formatDimensions(2, 2)} zone.
                  </p>
                  <p className="note">
                    {live.congestion_samples === undefined
                      ? "Congestion data is unavailable for this live run."
                      : `The overlay accumulates crowd delay since the run began, using simulated time. At least two nearby people must slow together to contribute. Larger queues and longer waits add more heat; freely moving traffic adds none. Red means ${CONGESTION_RED_REFERENCE_SECONDS}+ crowd-delay person-seconds in the smoothed area. This is a simplified simulation measure.`}{" "}
                    Rewind, replay and peak crowding snapshots are available
                    after the run.
                  </p>
                </section>
              </SimulationDetails>
            )}
          </div>
          <div
            className="live-agent-chat"
            onKeyDown={(event) => {
              if (event.key === "Escape" && showAgentChat) {
                event.stopPropagation();
                closeChat();
              }
            }}
          >
            {showAgentChat && (
              <AgentChat
                building={building}
                result={null}
                time={(frame?.step ?? 0) * building.time_step_seconds}
                liveChat={chat}
                onClose={closeChat}
              />
            )}
            <button
              ref={chatButton}
              type="button"
              className="studio-control live-chat-notification"
              aria-expanded={showAgentChat}
              aria-controls="agent-chat"
              onClick={() => {
                if (showAgentChat) closeChat();
                else {
                  setReadThrough(chat.total);
                  onChatOpenChange(true);
                }
              }}
            >
              <span>Agent chat</span>
              <span className="live-chat-preview">
                {lastMessage
                  ? chatSummaryMessage(lastMessage, building)
                  : "Waiting for messages…"}
              </span>
              {unread > 0 && (
                <span
                  className="live-chat-count"
                  aria-label={`${unread} unread updates`}
                >
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
              <span aria-hidden="true">{showAgentChat ? "▾" : "▴"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
