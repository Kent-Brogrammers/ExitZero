import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BuildingScenario } from "../types/simulation";
import { drawLayout } from "../editor/draw";
import type { DraftingPreferences } from "../editor/drafting";
import { canvasPalette } from "../styles/canvasPalette";
import { useStudioTheme } from "../styles/appearance";
import { trafficBins } from "../analytics/traffic";
import { fieldPixels, trafficField } from "../analytics/trafficField";
import { loadOfficeTraffic, type OfficeTraffic } from "./officeTraffic";
import "./OfficeDemo.css";

// A presentation preference, independent of the editor's persisted grid/snap settings.
const grid: DraftingPreferences = {
  visible: true,
  spacing: "1m",
  snap: false,
  doorMergeTolerance: 0.1,
};

export function WelcomePreview({
  building,
  officeDemo,
}: {
  building: BuildingScenario;
  officeDemo: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useStudioTheme();
  const id = useId();
  const [loaded, setLoaded] = useState<{
    building: BuildingScenario;
    traffic: OfficeTraffic | null;
  } | null>(null);
  const [mode, setMode] = useState<"floor" | "traffic" | null>(null);
  const traffic =
    officeDemo && loaded?.building === building ? loaded.traffic : null;
  const unavailable = officeDemo && loaded?.building === building && !traffic;
  const showTraffic = !!traffic && mode !== "floor";
  useEffect(() => {
    if (!officeDemo) return;
    const controller = new AbortController();
    loadOfficeTraffic(building, controller.signal).then(
      (traffic) => {
        if (!controller.signal.aborted) setLoaded({ building, traffic });
      },
      () => {
        if (!controller.signal.aborted) setLoaded({ building, traffic: null });
      },
    );
    return () => controller.abort();
  }, [building, officeDemo]);
  const field = useMemo(
    () =>
      traffic
        ? trafficField(
            trafficBins(traffic.traffic_samples, traffic.width, traffic.height),
            traffic.width,
            traffic.height,
            0.6,
          )
        : null,
    [traffic],
  );

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const layer = document.createElement("canvas");
    if (showTraffic && field) {
      layer.width = field.columns;
      layer.height = field.rows;
      const context = layer.getContext("2d");
      if (context) {
        const pixels = context.createImageData(field.columns, field.rows);
        pixels.data.set(fieldPixels(field));
        context.putImageData(pixels, 0, 0);
      }
    }
    const redraw = () =>
      drawLayout(
        target,
        building,
        null,
        undefined,
        window.devicePixelRatio || 1,
        canvasPalette(target),
        {
          grid,
          showDimensions: false,
          underlay:
            showTraffic && field
              ? (context) => {
                  context.save();
                  context.beginPath();
                  context.rect(0, 0, building.width, building.height);
                  context.clip();
                  context.imageSmoothingEnabled = true;
                  context.imageSmoothingQuality = "high";
                  context.drawImage(
                    layer,
                    0,
                    0,
                    building.width,
                    building.height,
                  );
                  context.restore();
                }
              : undefined,
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
  }, [building, theme, showTraffic, field]);

  return (
    <>
      <div className="welcome-drawing-heading">
        <span>{officeDemo ? "OFFICE DEMO / 01" : "THE FLOOR PLAN / 01"}</span>
        {officeDemo && (
          <div
            className="welcome-preview-controls"
            role="group"
            aria-label="Office preview visualization"
          >
            <button
              type="button"
              className="studio-control"
              aria-controls={id}
              aria-pressed={!showTraffic}
              onClick={() => setMode("floor")}
            >
              Floor Plan
            </button>
            <button
              type="button"
              className="studio-control"
              aria-controls={id}
              aria-pressed={showTraffic}
              disabled={!traffic}
              onClick={() => setMode("traffic")}
            >
              Traffic Heatmap
            </button>
          </div>
        )}
        <span>
          {building.width} × {building.height} m
        </span>
      </div>
      <canvas
        data-world-canvas
        id={id}
        ref={canvas}
        width={900}
        height={720}
        role="img"
        aria-describedby={`${id}-caption`}
        aria-label={
          showTraffic
            ? "Office floor plan with recorded accumulated traffic from the saved Rust simulation. No simulation is running."
            : officeDemo
              ? "Office demo floor plan with open workspace, meeting room, corridor, break room and two exits. No simulation is running."
              : "Illustrative example building floor plan. No simulation is running."
        }
      />
      <div className="welcome-preview-caption" id={`${id}-caption`}>
        {showTraffic ? (
          <>
            <span className="welcome-preview-legend">
              Recorded traffic <span>Low</span>
              <span className="office-demo-scale" aria-hidden="true" />
              <span>High</span>
            </span>
            <span>Accumulated visits · not density or proven congestion</span>
          </>
        ) : (
          <span role="status">
            {unavailable
              ? "Recorded traffic unavailable · Floor plan shown"
              : officeDemo && !traffic
                ? "Loading recorded traffic…"
                : "Blueprint floor plan · 1 m grid"}
          </span>
        )}
      </div>
    </>
  );
}
