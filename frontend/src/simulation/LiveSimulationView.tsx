import { formatDimensions } from "../utils/units";
import { useEffect, useRef, type ReactNode } from "react";
import { SimulationDetails } from "./SimulationDetails";
import { PursuitMetrics } from "./PursuitMetrics";
import type {
  AnimationFrame,
  BuildingScenario,
  LiveSimulation,
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
  agentChat,
}: {
  building: BuildingScenario;
  live: LiveSimulation;
  active: boolean;
  showAgentNumbers?: boolean;
  agentChat?: ReactNode;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useStudioTheme();

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
      const frame =
        snapshot.sample?.(
          snapshot.fromTime + (now - snapshot.receivedAt) / 1000,
        ) ?? null;
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
  }, [active, building, theme, showAgentNumbers]);

  const population = building.spawn_zones.reduce(
    (sum, zone) => sum + zone.count,
    0,
  );
  const frame = live.frame;
  return (
    <div className="playback-workspace">
      <div className="playback-stage">
        <div className="canvas-wrap playback-canvas-wrap">
          {agentChat}
          <canvas
            data-world-canvas
            ref={canvas}
            width={1200}
            height={800}
            role="img"
            aria-label={
              frame
                ? `Live evacuation at step ${frame.step}, ${frame.agents.length} occupants remaining.`
                : "Preparing the live evacuation."
            }
          />
          <div className="canvas-caption">
            <span>{formatDimensions(building.width, building.height)}</span>
            <span>
              {frame
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
                    <dd role="status">{frame ? "Live" : "Starting…"}</dd>
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
                    Colors show current positions, relative to this frame. They
                    are not accumulated traffic or validated congestion
                    measurements. Rewind, replay and peak crowding snapshots are
                    available after the run.
                  </p>
                </section>
              </SimulationDetails>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
