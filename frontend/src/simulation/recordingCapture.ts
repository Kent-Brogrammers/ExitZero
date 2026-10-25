import type { BuildingScenario, SimulationResult } from "../types/simulation";
import { createExportRenderer } from "./exportRendering";
import { finalizeWebmDuration } from "./webmDuration";

export interface RecordingExportOptions {
  resolution: 720 | 1080;
  includeHeatmap: boolean;
  showAgentNumbers: boolean;
}

export function recordingExportProblem(
  building: BuildingScenario,
  result: SimulationResult | null,
  synthetic = false,
): string | null {
  if (synthetic)
    return "Synthetic previews cannot be exported. Run a real simulation first.";
  if (!result)
    return "Run a simulation and wait for its recording before exporting.";
  if (result.width !== building.width || result.height !== building.height)
    return "This recording does not match the current layout.";
  if (result.frames.length < 2)
    return "Export needs at least two recorded frames with a positive duration.";
  if (
    !Number.isFinite(result.time_step_seconds) ||
    result.time_step_seconds <= 0 ||
    result.frames.some(
      (frame, index) =>
        !Number.isFinite(frame.step) ||
        frame.step < 0 ||
        (index > 0 && frame.step <= result.frames[index - 1]!.step),
    )
  )
    return "The recording has invalid timestamps and cannot be exported.";
  return null;
}

export function webmExportType(): string | null {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function" ||
    typeof HTMLCanvasElement === "undefined" ||
    typeof HTMLCanvasElement.prototype.captureStream !== "function"
  )
    return null;
  try {
    return (
      ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"].find(
        (mime) => MediaRecorder.isTypeSupported(mime),
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** Native capture runs at 1x wall time, using recorded timestamps, not frame count. */
export async function exportRecording(
  building: BuildingScenario,
  result: SimulationResult,
  options: RecordingExportOptions,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const problem = recordingExportProblem(building, result);
  if (problem) throw new Error(problem);
  signal.throwIfAborted();
  const mimeType = webmExportType();
  if (!mimeType)
    throw new Error(
      "This browser cannot export WebM from a Canvas. Try a browser with Canvas capture and WebM MediaRecorder support.",
    );
  if (document.hidden)
    throw new Error("Keep this tab visible while exporting.");
  const first = result.frames[0]!.step * result.time_step_seconds;
  const last = result.frames.at(-1)!.step * result.time_step_seconds;
  const duration = last - first;
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("The recording has no exportable duration.");
  const canvas = document.createElement("canvas");
  canvas.dataset.recordingExportCanvas = "true";
  if (building.pursuit) canvas.setAttribute("data-halloween", "true");
  canvas.setAttribute("aria-hidden", "true");
  const width = options.resolution === 1080 ? 1920 : 1280,
    height = options.resolution;
  Object.assign(canvas.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${width}px`,
    height: `${height}px`,
    pointerEvents: "none",
  });
  document.body.append(canvas);
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let animation = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  const chunks: Blob[] = [];
  return new Promise<Blob>((resolve, reject) => {
    let settled = false,
      stopping = false;
    const cleanup = () => {
      cancelAnimationFrame(animation);
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelled);
      document.removeEventListener("visibilitychange", visibility);
      if (recorder) {
        recorder.ondataavailable =
          recorder.onstop =
          recorder.onerror =
          recorder.onstart =
            null;
        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            /* Already stopped by the browser. */
          }
        }
      }
      stream?.getTracks().forEach((track) => track.stop());
      chunks.length = 0;
      canvas.remove();
    };
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };
    const cancelled = () =>
      fail(new DOMException("Export cancelled.", "AbortError"));
    const visibility = () => {
      if (document.hidden)
        fail(
          new Error(
            "Export stopped because the tab was hidden. Keep the tab visible and try again.",
          ),
        );
    };
    signal.addEventListener("abort", cancelled, { once: true });
    document.addEventListener("visibilitychange", visibility);
    try {
      if (!canvas.getContext("2d"))
        throw new Error("The export Canvas is unavailable.");
      const draw = createExportRenderer(canvas, building, result, options);
      draw(first);
      stream = canvas.captureStream(30);
      const track = stream.getVideoTracks()[0] as
        CanvasCaptureMediaStreamTrack | undefined;
      if (!track)
        throw new Error("The browser did not create a video capture track.");
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: height === 1080 ? 6_000_000 : 3_000_000,
      });
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () =>
        fail(
          new Error(
            "The browser could not encode this recording. Try 720p or another browser.",
          ),
        );
      recorder.onstop = () => {
        if (settled) return;
        if (!stopping) {
          fail(
            new Error(
              "Video capture ended before the recording finished. No file was downloaded.",
            ),
          );
          return;
        }
        const blob = new Blob(chunks, { type: recorder!.mimeType || mimeType });
        if (!blob.size) {
          fail(
            new Error(
              "The browser produced an empty video. Try another browser.",
            ),
          );
          return;
        }
        settled = true;
        cleanup();
        onProgress(1);
        resolve(finalizeWebmDuration(blob, duration));
      };
      recorder.onstart = () => {
        clearTimeout(timer);
        const start = performance.now();
        let previous = start;
        onProgress(0);
        const tick = (now: number) => {
          if (settled || stopping) return;
          try {
            // A long stalled callback would create a frozen section in native capture.
            if (now - previous > 1500)
              throw new Error(
                "Export stopped after a rendering stall. Keep this tab visible or try 720p.",
              );
            previous = now;
            const elapsed = Math.min(
              duration,
              Math.max(0, (now - start) / 1000),
            );
            draw(first + elapsed);
            track.requestFrame?.();
            onProgress(elapsed / duration);
            if (elapsed >= duration) {
              stopping = true;
              // Allow one capture interval for the exact final sample before stopping.
              timer = setTimeout(() => {
                if (!settled && recorder?.state !== "inactive") {
                  recorder!.stop();
                  timer = setTimeout(
                    () =>
                      fail(
                        new Error(
                          "The video encoder did not finish. Try another browser.",
                        ),
                      ),
                    10000,
                  );
                }
              }, 1000 / 30);
            } else animation = requestAnimationFrame(tick);
          } catch (error) {
            fail(error);
          }
        };
        animation = requestAnimationFrame(tick);
      };
      timer = setTimeout(
        () =>
          fail(
            new Error("The video encoder did not start. Try another browser."),
          ),
        10000,
      );
      recorder.start(1000);
      if (signal.aborted) cancelled();
    } catch (error) {
      fail(error);
    }
  });
}

export function downloadRecording(blob: Blob, resolution: number) {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = `exitzero-recording-${resolution}p.webm`;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
