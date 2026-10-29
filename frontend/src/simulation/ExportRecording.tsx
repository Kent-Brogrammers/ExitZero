import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BuildingScenario, SimulationResult } from "../types/simulation";
import {
  downloadRecording,
  exportRecording,
  recordingExportProblem,
  webmExportType,
  type RecordingExportOptions,
} from "./recordingCapture";
import "./RecordingExport.css";

export function RecordingExport({
  building,
  result,
  synthetic,
  active,
  showAgentNumbers,
  onOpen,
}: {
  building: BuildingScenario;
  result: SimulationResult | null;
  synthetic: boolean;
  active: boolean;
  showAgentNumbers: boolean;
  onOpen: () => void;
}) {
  const [source, setSource] = useState<{
    building: BuildingScenario;
    result: SimulationResult;
    numbers: boolean;
  } | null>(null);
  const problem = useMemo(
    () => recordingExportProblem(building, result, synthetic),
    [building, result, synthetic],
  );
  useEffect(() => {
    setSource(null);
  }, [building, result, active]);
  return (
    <>
      <button
        type="button"
        className="studio-control"
        disabled={!!problem || !active}
        title={problem ?? "Download the full real recording at 1× speed."}
        onClick={() => {
          if (problem || !result) return;
          onOpen();
          setSource({ building, result, numbers: showAgentNumbers });
        }}
      >
        Export Recording
      </button>
      {source &&
        active &&
        source.result === result &&
        source.building === building && (
          <ExportDialog
            building={source.building}
            result={source.result}
            numbers={source.numbers}
            onClose={() => setSource(null)}
          />
        )}
    </>
  );
}

function ExportDialog({
  building,
  result,
  numbers,
  onClose,
}: {
  building: BuildingScenario;
  result: SimulationResult;
  numbers: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const job = useRef<AbortController | null>(null);
  const title = useId();
  const [mime] = useState(webmExportType);
  const [options, setOptions] = useState<RecordingExportOptions>({
    resolution: 720,
    includeHeatmap: true,
    showAgentNumbers: numbers,
  });
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const first = result.frames[0]!.step * result.time_step_seconds;
  const last = result.frames.at(-1)!.step * result.time_step_seconds;
  useEffect(() => {
    const target = dialog.current,
      previous = document.activeElement;
    target?.showModal();
    return () => {
      job.current?.abort();
      job.current = null;
      target?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  async function start() {
    if (job.current || !mime) return;
    const controller = new AbortController();
    job.current = controller;
    setRunning(true);
    setMessage("");
    setProgress(0);
    try {
      const blob = await exportRecording(
        building,
        result,
        options,
        controller.signal,
        (fraction) => {
          if (job.current === controller) setProgress(fraction);
        },
      );
      if (job.current !== controller || controller.signal.aborted) return;
      downloadRecording(blob, options.resolution);
      setMessage("Recording downloaded.");
    } catch (error) {
      if (job.current === controller)
        setMessage(
          controller.signal.aborted
            ? "Export cancelled. No file was downloaded."
            : error instanceof Error
              ? error.message
              : "The recording could not be exported.",
        );
    } finally {
      if (job.current === controller) {
        job.current = null;
        setRunning(false);
      }
    }
  }
  return (
    <dialog
      ref={dialog}
      className="recording-export-dialog"
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <h2 id={title}>Export Recording</h2>
        <p>
          Full recording · {(last - first).toFixed(2)} s · 1× speed ·{" "}
          {result.status}
        </p>
        <fieldset disabled={running}>
          <label>
            Format
            <select defaultValue="webm" disabled={running || !mime}>
              <option value="webm" disabled={!mime}>
                WebM video
              </option>
              <option value="gif" disabled>
                GIF — unavailable
              </option>
            </select>
          </label>
          <label>
            Resolution
            <select
              value={options.resolution}
              onChange={(event) =>
                setOptions({
                  ...options,
                  resolution: Number(event.target.value) as 720 | 1080,
                })
              }
            >
              <option value={720}>720p · 1280 × 720</option>
              <option value={1080}>1080p · 1920 × 1080</option>
            </select>
          </label>
          <label className="export-check">
            <input
              type="checkbox"
              checked={options.includeHeatmap}
              onChange={(event) =>
                setOptions({ ...options, includeHeatmap: event.target.checked })
              }
            />
            Include congestion heatmap
          </label>
          <label className="export-check">
            <input
              type="checkbox"
              checked={options.showAgentNumbers}
              onChange={(event) =>
                setOptions({
                  ...options,
                  showAgentNumbers: event.target.checked,
                })
              }
            />
            Show agent numbers
          </label>
        </fieldset>
        {!mime && (
          <p role="alert">
            WebM export is unavailable in this browser. Canvas capture and a
            WebM MediaRecorder encoder are required.
          </p>
        )}
        <p>
          Exports the full recording at 1× with no audio. Keep this tab visible.
          GIF is unavailable because no GIF encoder is included.
        </p>
        {options.includeHeatmap && (
          <p>
            The heatmap accumulates backend crowd-delay person-seconds, matching
            playback. Older recordings without congestion data export a clear
            overlay.
          </p>
        )}
        {running && (
          <div className="export-progress">
            <progress
              aria-label="Recording export progress"
              value={progress}
              max={1}
            />
            <output aria-live="off">
              {progress >= 1
                ? "Finishing video…"
                : `Exporting ${Math.floor(progress * 100)}%`}
            </output>
          </div>
        )}
        {message && <p role="status">{message}</p>}
        <div className="export-dialog-actions">
          {running ? (
            <button
              type="button"
              className="studio-control"
              onClick={() => job.current?.abort()}
            >
              Cancel export
            </button>
          ) : (
            <button type="button" className="studio-control" onClick={onClose}>
              Close
            </button>
          )}
          <button
            type="submit"
            className="studio-control export-primary"
            disabled={running || !mime}
          >
            {running ? "Exporting…" : "Export WebM"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
