import { useEffect, useRef } from "react";
import type {
  AnimationFrame,
  BuildingScenario,
  LiveSimulation,
} from "../types/simulation";
import { useStudioTheme } from "../styles/appearance";
import { createPlaybackRenderer } from "./drawPlayback";
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
  const latest = useRef<{
    frame: AnimationFrame | null;
    sample: ReturnType<typeof createFrameSampler> | null;
    fromTime: number;
    receivedAt: number;
  }>({ frame: null, sample: null, fromTime: 0, receivedAt: 0 });

  useEffect(() => {
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
    const render = createPlaybackRenderer(canvas.current, building);
    let animation = 0;
    function tick(now: number) {
      const snapshot = latest.current;
      // Interpolate only between physics samples already received. The live
      // view never predicts future positions or needs the run's duration.
      render(
        snapshot.sample?.(
          snapshot.fromTime + (now - snapshot.receivedAt) / 1000,
        ) ?? null,
        window.devicePixelRatio,
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
            Recording this run as it happens. Rewind and replay become available
            when it finishes.
          </p>
        </div>
      </div>
    </div>
  );
}
