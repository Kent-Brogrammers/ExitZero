import { formatLength, formatDimensions } from "../utils/units";
import { useEffect, useRef, useState } from "react";
import type { BuildingScenario, SimulationResult } from "../types/simulation";
import { drawLayout } from "../editor/draw";
import { canvasPalette } from "../styles/canvasPalette";
import { useStudioTheme } from "../styles/appearance";
import { congestionBins } from "./traffic";
import { trafficField, fieldPixels } from "./trafficField";

export default function TrafficHeatmap({
  building,
  result,
}: {
  building?: BuildingScenario;
  result: SimulationResult | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useStudioTheme();
  const [visible, setVisible] = useState(true);
  const [smoothing, setSmoothing] = useState(0.6);
  const traffic = result?.congestion_samples
    ? congestionBins(result.congestion_samples, result.width, result.height)
    : null;
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
      pixels.data.set(fieldPixels(field));
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
  }, [building, result, visible, matches, smoothing, theme]);
  return (
    <section className="panel traffic-panel" aria-label="Congestion heatmap">
      <div className="panel-heading">
        <h2>Congestion</h2>
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
              COMPUTED CONGESTION · SMOOTH VIEW
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
            aria-label={`Congestion from the standalone simulation on a ${formatDimensions(result.width, result.height)} floor plan. Maximum ${(traffic?.max ?? 0).toFixed(2)} crowd-delay person-seconds per spatial bin.`}
          />
          {traffic?.max ? (
            <div className="traffic-legend">
              <span>Lower intensity</span>
              <span className="traffic-gradient" aria-hidden="true" />
              <span>Higher intensity</span>
              <span className="traffic-peak">
                Peak source bin: {traffic.max.toFixed(2)} person-seconds
              </span>
            </div>
          ) : (
            <p className="note">No crowd delay was recorded.</p>
          )}
          <div className="note traffic-explanation">
            <p>
              Crowd-delay person-seconds accumulate while people are near others
              and move below walking speed. More people, longer waits, and
              slower movement add heat; freely moving traffic adds none. Colors
              are relative to this run and smoothed for display, so color can
              extend across walls. This is a simplified simulation measure, not
              validated real-world crowd density. Scenario selection does not
              change this map.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
import { frameLayout } from "../simulation/frameLayout";
