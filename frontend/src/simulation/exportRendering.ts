import { createAgentEffects } from "./agentEffects";
import type { BuildingScenario, SimulationResult } from "../types/simulation";
import { canvasPalette } from "../styles/canvasPalette";
import { drawLayout } from "../editor/draw";
import { trafficField, fieldPixels } from "../analytics/trafficField";
import { createPlaybackRenderer, drawAgents } from "./drawPlayback";
import { createFrameSampler } from "./interpolation";
import { createRecordedTrails } from "./recordedTrails";
import { frameIndexAtTime } from "./playback";
import { frameLayout } from "./frameLayout";
import type { RecordingExportOptions } from "./recordingCapture";

/** Own samplers/caches: export never advances or seeks the normal player. */
export function createExportRenderer(
  canvas: HTMLCanvasElement,
  building: BuildingScenario,
  result: SimulationResult,
  options: RecordingExportOptions,
) {
  const palette = canvasPalette(canvas);
  const sample = createFrameSampler(
    building,
    result.frames,
    result.time_step_seconds,
  );
  const plain = createPlaybackRenderer(canvas, building);
  const effects = createAgentEffects([
    ...(result.communication_events ?? []),
    ...(result.agent_events ?? []),
  ]);
  const trails = createRecordedTrails(result);
  const peak = options.includeHeatmap
    ? trafficField(
        trails(result.frames.length - 1),
        result.width,
        result.height,
        0.6,
      ).peak
    : 0;
  trails(0);
  const layer = canvas.ownerDocument.createElement("canvas");
  let lastIndex = -1;
  return (seconds: number) => {
    const frame = sample(seconds);
    if (!options.includeHeatmap) {
      plain(frame, 1, options.showAgentNumbers);
      effects(canvas, building, frame, seconds, 1);
      return;
    }
    const index = frameIndexAtTime(
      result.frames,
      result.time_step_seconds,
      seconds,
    );
    if (index !== lastIndex) {
      const field = trafficField(
        trails(index),
        result.width,
        result.height,
        0.6,
      );
      layer.width = field.columns;
      layer.height = field.rows;
      const context = layer.getContext("2d");
      if (!context) throw new Error("The export Canvas is unavailable.");
      const pixels = context.createImageData(field.columns, field.rows);
      pixels.data.set(fieldPixels({ ...field, peak }));
      context.putImageData(pixels, 0, 0);
      lastIndex = index;
    }
    drawLayout(
      canvas,
      frameLayout(building, frame),
      null,
      undefined,
      1,
      palette,
      {
        windowStates: frame?.window_states,
        disasterState: frame?.disaster_state,
        showPursuitStart: false,
        underlay: (context) => {
          context.save();
          context.beginPath();
          context.rect(0, 0, building.width, building.height);
          context.clip();
          context.imageSmoothingEnabled = true;
          context.drawImage(layer, 0, 0, building.width, building.height);
          context.restore();
        },
      },
    );
    drawAgents(canvas, building, frame, 1, palette, options.showAgentNumbers);
    effects(canvas, building, frame, seconds, 1);
  };
}
