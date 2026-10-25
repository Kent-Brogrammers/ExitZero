import { formatDimensions, lengthInputValue } from "../utils/units";
import { useEffect, useMemo, useRef } from "react";
import type { BuildingScenario, SimulationResult } from "../types/simulation";
import { drawLayout } from "../editor/draw";
import { canvasPalette } from "../styles/canvasPalette";
import { drawAgents } from "../simulation/drawPlayback";
import { frameLayout } from "../simulation/frameLayout";
import {
  CROWD_ZONE,
  createCrowdingTracker,
  frameCrowding,
  type CrowdingSpot,
} from "./crowding";
import "./crowding.css";
import { trafficBins } from "./traffic";
import { trafficField, fieldPixels } from "./trafficField";

function snapshotField(building: BuildingScenario, spot: CrowdingSpot) {
  const zones = frameCrowding(spot.frame, building.width, building.height);
  const samples = zones.map((zone) => ({
    x: zone.x + Math.min(CROWD_ZONE, building.width - zone.x) / 2,
    y: zone.y + Math.min(CROWD_ZONE, building.height - zone.y) / 2,
    visits: zone.count,
  }));
  return trafficField(
    trafficBins(samples, building.width, building.height),
    building.width,
    building.height,
    1.4,
  );
}
function Snapshot({
  building,
  spot,
  rank,
  field,
  peak,
  onViewInSimulation,
}: {
  building: BuildingScenario;
  spot: CrowdingSpot;
  rank: number;
  field: ReturnType<typeof trafficField>;
  peak: number;
  onViewInSimulation?: (step: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const layer = document.createElement("canvas");
    layer.width = field.columns;
    layer.height = field.rows;
    const layerContext = layer.getContext("2d");
    if (layerContext) {
      const pixels = layerContext.createImageData(field.columns, field.rows);
      pixels.data.set(fieldPixels({ ...field, peak }));
      layerContext.putImageData(pixels, 0, 0);
    }
    const redraw = () => {
      const palette = canvasPalette(target);
      drawLayout(
        target,
        frameLayout(building, spot.frame),
        null,
        undefined,
        window.devicePixelRatio || 1,
        palette,
        {
          hazardMode: "filled",
          showBlockedLabels: false,
          disasterState: spot.frame.disaster_state,
          windowStates: spot.frame.window_states,
          underlay: (ctx) => {
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, building.width, building.height);
            ctx.clip();
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(layer, 0, 0, building.width, building.height);
            ctx.restore();
            ctx.strokeStyle = "#ffbc67";
            ctx.lineWidth = 0.08;
            ctx.strokeRect(
              spot.x,
              spot.y,
              Math.min(CROWD_ZONE, building.width - spot.x),
              Math.min(CROWD_ZONE, building.height - spot.y),
            );
          },
        },
      );
      drawAgents(
        target,
        building,
        spot.frame,
        window.devicePixelRatio || 1,
        palette,
      );
    };
    const observer = new ResizeObserver(redraw);
    observer.observe(target);
    redraw();
    return () => observer.disconnect();
  }, [building, spot, field, peak]);
  return (
    <article className="crowding-card">
      <div className="crowding-card-heading">
        <strong>
          #{rank} · {spot.count} occupants together
        </strong>
        <span>
          {(spot.frame.step * building.time_step_seconds).toFixed(2)} s
        </span>
      </div>
      <canvas
        ref={canvas}
        role="img"
        aria-label={`Crowding heatmap snapshot ${rank}: ${spot.count} occupants in the highlighted zone at x ${lengthInputValue(spot.x, 2)}, y ${lengthInputValue(spot.y, 2)} feet, step ${spot.frame.step}.`}
      />
      <p>
        Zone: ({lengthInputValue(spot.x, 2)}, {lengthInputValue(spot.y, 2)}) ft
        ·{" "}
        {formatDimensions(
          Math.min(CROWD_ZONE, building.width - spot.x),
          Math.min(CROWD_ZONE, building.height - spot.y),
        )}
        {spot.frame.step === 0 ? " · Initial occupancy" : ""}
      </p>
      {onViewInSimulation && (
        <button
          type="button"
          onClick={() => onViewInSimulation(spot.frame.step)}
          aria-label={`View crowded spot ${rank} in simulation at ${(spot.frame.step * building.time_step_seconds).toFixed(2)} seconds`}
        >
          View in simulation ↗
        </button>
      )}
    </article>
  );
}
function Cards({
  building,
  spots,
  onViewInSimulation,
}: {
  building: BuildingScenario;
  spots: CrowdingSpot[];
  onViewInSimulation?: (step: number) => void;
}) {
  const fields = useMemo(
    () => spots.map((spot) => snapshotField(building, spot)),
    [building, spots],
  );
  const peak = Math.max(0, ...fields.map((field) => field.peak));
  return (
    <section
      className="panel crowding-panel"
      aria-label="Peak crowding rankings"
    >
      <h2>Peak crowding</h2>
      <p className="note">
        Three busiest {formatDimensions(CROWD_ZONE, CROWD_ZONE)} zones in
        recorded frames, including initial occupancy. Ranked by occupant count,
        not density or proven congestion; boundary zones may be smaller.
      </p>
      <div className="crowding-legend">
        <span>Fewer occupants</span>
        <span className="crowding-gradient" aria-hidden="true" />
        <span>More occupants</span>
        <span>Outlined zone = ranked spot</span>
      </div>
      <details className="note">
        <summary>How to read these snapshots</summary>
        <p>
          Each snapshot shows its zone's peak timestamp on a shared color scale.
          Smoothed colors may spread beyond zone edges. Occupant count
          determines rank.
        </p>
      </details>
      {spots.length ? (
        <div className="crowding-cards">
          {spots.map((spot, i) => (
            <Snapshot
              key={`${spot.x},${spot.y}`}
              building={building}
              spot={spot}
              rank={i + 1}
              field={fields[i]!}
              peak={peak}
              onViewInSimulation={onViewInSimulation}
            />
          ))}
        </div>
      ) : (
        <p className="note">
          Crowding snapshots will appear as occupant frames arrive.
        </p>
      )}
    </section>
  );
}
export default function CrowdingRanking({
  building,
  result,
  onViewInSimulation,
}: {
  building?: BuildingScenario;
  result: SimulationResult | null;
  onViewInSimulation?: (step: number) => void;
}) {
  const spots = useMemo(() => {
    if (!result) return [];
    const tracker = createCrowdingTracker(result.width, result.height);
    for (const frame of result.frames) tracker.add(frame);
    return tracker.getSnapshot();
  }, [result]);
  if (
    !result ||
    !building ||
    result.width !== building.width ||
    result.height !== building.height
  )
    return null;
  return (
    <Cards
      building={building}
      spots={spots}
      onViewInSimulation={onViewInSimulation}
    />
  );
}
