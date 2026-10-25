import { useEffect, useRef, useState } from "react";
import type { BuildingScenario, SimulationResult } from "../types/simulation";
import { drawLayout } from "../editor/draw";
import { canvasPalette } from "../styles/canvasPalette";
import { useStudioTheme } from "../styles/appearance";
import { trafficBins } from "./traffic";
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
  const traffic = result
    ? trafficBins(result.traffic_samples, result.width, result.height)
    : null;
  const matches =
    !!building &&
    !!result &&
    building.width === result.width &&
    building.height === result.height;
  useEffect(() => {
    const target = canvas.current;
    if (!target || !building || !result || !matches) return;
    const data = trafficBins(
      result.traffic_samples,
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
    <section
      className="panel traffic-panel"
      aria-label="Accumulated traffic heatmap"
    >
      <div className="panel-heading">
        <h2>Accumulated traffic</h2>
        <label>
          <input
            type="checkbox"
            checked={visible}
            onChange={(event) => setVisible(event.target.checked)}
          />{" "}
          Show traffic
        </label>
      </div>
      {!result ? (
        <p className="note">
          Run a simulation to see traffic on its floor plan. Stress-test
          summaries do not include traffic samples.
        </p>
      ) : !matches ? (
        <p className="note">
          A matching floor plan is required to display traffic.
        </p>
      ) : (
        <>
          <div className="traffic-tools">
            <span className="traffic-mode">COMPUTED TRAFFIC · SMOOTH VIEW</span>
            <label>
              Smoothing{" "}
              <input
                type="range"
                min="0.25"
                max="1.5"
                step="0.05"
                value={smoothing}
                onChange={(event) => setSmoothing(Number(event.target.value))}
                aria-label="Traffic smoothing radius"
              />{" "}
              {smoothing.toFixed(2)} m
            </label>
          </div>
          <canvas
            ref={canvas}
            className="traffic-canvas"
            role="img"
            aria-label={`Traffic from the standalone simulation on a ${result.width} by ${result.height} metre floor plan. Maximum ${traffic?.max ?? 0} visits per spatial bin.`}
          />
          {traffic?.max ? (
            <div className="traffic-legend">
              <span>Lower intensity</span>
              <span className="traffic-gradient" aria-hidden="true" />
              <span>Higher intensity</span>
              <span className="traffic-peak">
                Peak source bin: {traffic.max} visits
              </span>
            </div>
          ) : (
            <p className="note">No positive traffic samples were returned.</p>
          )}
          <details className="note">
            <summary>About recorded traffic</summary>
            <p>
              Computed visits, smoothed for display. Color may extend beyond
              recorded paths; it does not predict movement through walls. Source
              counts are unchanged ({traffic?.size.toFixed(2)} m bins). Colors
              are relative to this run, not density or measured congestion.
              Scenario selection does not change this map.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
import { frameLayout } from "../simulation/frameLayout";
