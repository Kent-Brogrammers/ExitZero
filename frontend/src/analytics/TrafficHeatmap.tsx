import { formatLength, formatDimensions } from "../utils/units";
import { useDisplayUnits } from "../utils/useDisplayUnits";
import { useEffect, useRef, useState } from "react";
import type { BuildingScenario, SimulationResult } from "../types/simulation";
import { drawLayout } from "../editor/draw";
import { canvasPalette } from "../styles/canvasPalette";
import { useStudioTheme } from "../styles/appearance";
import { congestionBins } from "./traffic";
import {
  trafficField,
  congestionPixels,
  CONGESTION_RED_REFERENCE_SECONDS,
} from "./trafficField";

export default function TrafficHeatmap({
  building,
  result,
}: {
  building?: BuildingScenario;
  result: SimulationResult | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useStudioTheme();
  const units = useDisplayUnits();
  const [visible, setVisible] = useState(true);
  const [smoothing, setSmoothing] = useState(0.6);
  const traffic = result?.congestion_samples
    ? congestionBins(result.congestion_samples, result.width, result.height)
    : null;
  const elapsedSeconds = result
    ? (result.analytics?.simulated_seconds ??
      (result.frames.at(-1)?.step ?? 0) * result.time_step_seconds)
    : 0;
  const peakDelay = traffic?.max ?? 0;
  const matches =
    !!building &&
    !!result &&
    building.width === result.width &&
    building.height === result.height;
  useEffect(() => {
    const target = canvas.current;
    if (!target || !building || !result?.congestion_samples || !matches) return;
    const data = congestionBins(
      result.congestion_samples,
      result.width,
      result.height,
    );
    const field = trafficField(data, result.width, result.height, smoothing);
    const layer = document.createElement("canvas");
    layer.width = field.columns;
    layer.height = field.rows;
    const layerContext = layer.getContext("2d");
    if (layerContext) {
      const pixels = layerContext.createImageData(field.columns, field.rows);
      pixels.data.set(congestionPixels(field, elapsedSeconds));
      layerContext.putImageData(pixels, 0, 0);
    }
    const redraw = () =>
      drawLayout(
        target,
        frameLayout(building, result.frames.at(-1) ?? null),
        null,
        undefined,
        window.devicePixelRatio || 1,
        canvasPalette(target),
        {
          hazardMode: "filled",
          showBlockedLabels: false,
          disasterState: result.frames.at(-1)?.disaster_state,
          underlay: (ctx) => {
            if (!visible || data.max === 0) return;
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, result.width, result.height);
            ctx.clip();
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(layer, 0, 0, result.width, result.height);
            ctx.restore();
          },
        },
      );
    const observer = new ResizeObserver(redraw);
    observer.observe(target);
    window.addEventListener("resize", redraw);
    redraw();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", redraw);
    };
  }, [
    building,
    result,
    visible,
    matches,
    smoothing,
    theme,
    units,
    elapsedSeconds,
  ]);
  return (
    <section className="panel traffic-panel" aria-label="Congestion heatmap">
      <div className="panel-heading">
        <h2>Accumulated congestion</h2>
        <label>
          <input
            type="checkbox"
            checked={visible}
            onChange={(event) => setVisible(event.target.checked)}
          />{" "}
          Show congestion
        </label>
      </div>
      {!result ? (
        <p className="note">
          Run a simulation to see congestion on its floor plan. Stress-test
          summaries do not include congestion samples.
        </p>
      ) : result.congestion_samples === undefined ? (
        <p className="note">
          Congestion data is unavailable for this recording. Rerun the
          simulation to measure crowd delay.
        </p>
      ) : !matches ? (
        <p className="note">
          A matching floor plan is required to display congestion.
        </p>
      ) : (
        <>
          <div className="traffic-tools">
            <span className="traffic-mode">
              ACCUMULATED CONGESTION · SMOOTH VIEW
            </span>
            <label>
              Smoothing{" "}
              <input
                type="range"
                min="0.25"
                max="1.5"
                step="0.05"
                value={smoothing}
                onChange={(event) => setSmoothing(Number(event.target.value))}
                aria-label="Congestion smoothing radius"
                aria-valuetext={formatLength(smoothing, 2)}
              />{" "}
              {formatLength(smoothing, 2)}
            </label>
          </div>
          <canvas
            ref={canvas}
            className="traffic-canvas"
            role="img"
            aria-label={`Accumulated congestion from the standalone simulation on a ${formatDimensions(result.width, result.height)} floor plan. Maximum ${peakDelay.toFixed(2)} crowd-delay person-seconds per spatial bin over ${elapsedSeconds.toFixed(2)} simulated seconds.`}
          />
          {traffic?.max ? (
            <div className="traffic-legend">
              <span>0</span>
              <span className="traffic-gradient" aria-hidden="true" />
              <span>
                {CONGESTION_RED_REFERENCE_SECONDS}+ crowd-delay person-seconds
              </span>
              <span className="traffic-peak">
                Peak source bin: {peakDelay.toFixed(2)} crowd-delay
                person-seconds
              </span>
            </div>
          ) : (
            <p className="note">No crowd delay was recorded.</p>
          )}
          <div className="note traffic-explanation">
            <p>
              Accumulated crowd delay: at least two nearby people must slow down
              together to contribute. Two people stopped for ten seconds add
              twenty person-seconds; two moving at half speed add ten. Larger
              queues and longer waits add more heat, while freely moving traffic
              adds none. Quiet time preserves recorded delay. Colors use a fixed
              scale across runs, reaching red at{" "}
              {CONGESTION_RED_REFERENCE_SECONDS} crowd-delay person-seconds in
              the smoothed area. Smoothing can extend color across walls. This
              is an exploratory slowdown indicator; the color reference is not a
              safety threshold or a density measure. Scenario selection does not
              change this map.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
import { frameLayout } from "../simulation/frameLayout";
