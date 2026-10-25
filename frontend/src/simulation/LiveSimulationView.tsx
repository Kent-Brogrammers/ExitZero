import { useEffect, useRef, useState } from "react";
import { SimulationDetails } from "./SimulationDetails";
import { AgentChat } from "./AgentChat";
import { chatSummaryMessage } from "./communication";
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
import { trafficField, fieldPixels } from "../analytics/trafficField";
import { trafficBins } from "../analytics/traffic";
import { frameCrowding } from "../analytics/crowding";

import { createFrameSampler } from "./interpolation";
import { frameLayout } from "./frameLayout";

export function LiveSimulationView({
  building,
  live,
  active,
  showAgentNumbers = false,
  showAgentChat,
  onChatOpenChange,
  onSpeedChange,
  onCancel,
}: {
  building: BuildingScenario;
  live: LiveSimulation;
  active: boolean;
  showAgentNumbers?: boolean;
  showAgentChat: boolean;
  onChatOpenChange: (open: boolean) => void;
  onSpeedChange?: (speed: LiveSpeedControl["speed"]) => void;
  onCancel?: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useStudioTheme();
  const cancelled = live.status === "cancelled";
  const speed = live.speed ?? 1;
  const nextSpeed = speed === 1 ? 2 : speed === 2 ? 4 : speed === 4 ? 8 : 1;
  const [readThrough, setReadThrough] = useState(0);
  const chatButton = useRef<HTMLButtonElement>(null);
  const chat = live.chat ?? { messages: [], total: 0 };
  const unread = showAgentChat ? 0 : Math.max(0, chat.total - readThrough);
  const lastMessage = chat.messages.at(-1);
  function closeChat() {
    setReadThrough(chat.total);
    onChatOpenChange(false);
    chatButton.current?.focus();
  }

  const heatLayer = useRef<HTMLCanvasElement | null>(null);
  const latest = useRef<{
    frame: AnimationFrame | null;
    sample: ReturnType<typeof createFrameSampler> | null;
    fromTime: number;
    receivedAt: number;
  }>({ frame: null, sample: null, fromTime: 0, receivedAt: 0 });

  useEffect(() => {
    const data = trafficBins(
      (live.frame?.agents ?? []).map((agent) => ({
        x: agent.x,
        y: agent.y,
        visits: 1,
      })),
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
      pixels.data.set(fieldPixels({ ...field, peak: Math.max(4, field.peak) }));
      ctx.putImageData(pixels, 0, 0);
    }
    heatLayer.current = layer;
    const previous = latest.current.frame;
    const frame = live.frame;
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
  }, [building, live.frame]);

  useEffect(() => {
    if (!active || !canvas.current) return;
    const target = canvas.current;
    const palette = canvasPalette(target);
    let animation = 0;
    function tick(now: number) {
      const snapshot = latest.current;
      const frame = cancelled
        ? snapshot.frame
        : (snapshot.sample?.(
            snapshot.fromTime + ((now - snapshot.receivedAt) / 1000) * speed,
          ) ?? null);
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
          underlay: (ctx) => {
            const layer = heatLayer.current;
            if (!layer) return;
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
      drawAgents(
        target,
        building,
        frame,
        window.devicePixelRatio || 1,
        palette,
        showAgentNumbers,
      );
      animation = requestAnimationFrame(tick);
    }
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [active, building, theme, showAgentNumbers, speed, cancelled]);

  const population = building.spawn_zones.reduce(
    (sum, zone) => sum + zone.count,
    0,
  );
  const frame = live.frame;
  return (
    <div className="playback-workspace">
      <div className="playback-stage">
        <div className="canvas-wrap playback-canvas-wrap">
          <canvas
            data-world-canvas
            ref={canvas}
            width={1200}
            height={800}
            role="img"
            aria-label={
              frame
                ? `${cancelled ? "Cancelled" : "Live"} evacuation at step ${frame.step}, ${frame.agents.length} occupants remaining.`
                : cancelled
                  ? "Evacuation cancelled before the first frame."
                  : "Preparing the live evacuation."
            }
          />
          <div className="canvas-caption">
            <span>
              {building.width} × {building.height} m
            </span>
            <span>
              {cancelled
                ? "Cancelled"
                : frame
                  ? building.disaster
                    ? `Alarm: ${building.disaster.kind.replace("_", " ")} · live`
                    : "Live · recording"
                  : "Preparing simulation…"}
            </span>
          </div>
        </div>
        <div className="playback-dock">
          <div className="live-run-controls">
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
                    occupants in a 2 × 2 m zone.
                  </p>
                  <p className="note">
                    Colors show current positions, relative to this frame. They
                    are not accumulated traffic or validated congestion
                    measurements. Rewind, replay and peak crowding snapshots are
                    available after the run.
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
