import { useEffect, useRef } from "react";
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

export function LiveSimulationView({
  building,
  live,
  active,
}: {
  building: BuildingScenario;
  live: LiveSimulation;
  active: boolean;
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
      // Interpolate only between physics samples already received. The live
      // view never predicts future positions or needs the run's duration.
      drawLayout(
        target,
        building,
        null,
        undefined,
        window.devicePixelRatio || 1,
        palette,
        {
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
        snapshot.sample?.(
          snapshot.fromTime + (now - snapshot.receivedAt) / 1000,
        ) ?? null,
        window.devicePixelRatio || 1,
        palette,
      );
      animation = requestAnimationFrame(tick);
    }
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [active, building, theme]);

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
            <span>
              {building.width} × {building.height} m
            </span>
            <span>{frame ? "Live · recording" : "Preparing simulation…"}</span>
          </div>
        </div>
        <p className="note live-trails-note">
          Current busiest zone:{" "}
          {live.frame
            ? Math.max(
                0,
                ...frameCrowding(
                  live.frame,
                  building.width,
                  building.height,
                ).map((spot) => spot.count),
              )
            : 0}{" "}
          occupants in a 2 × 2 m zone.
        </p>
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
              <div>
                <dt>Remaining</dt>
                <dd>{frame?.agents.length ?? "—"}</dd>
              </div>
              <div>
                <dt>Evacuated</dt>
                <dd>{frame ? population - frame.agents.length : "—"}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd role="status">{frame ? "Live" : "Starting…"}</dd>
              </div>
            </dl>
          </div>
          <p className="note">
            Live crowding shows current occupant positions and cools as people
            leave. Colors are relative to the current frame, not cumulative
            traffic or a validated congestion measurement. Peak snapshots are
            available in Analytics after this run. Rewind and replay become
            available when it finishes.
          </p>
        </div>
      </div>
    </div>
  );
}
