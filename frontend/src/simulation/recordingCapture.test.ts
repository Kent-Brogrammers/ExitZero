import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  syntheticBuilding as building,
  syntheticResult as fixture,
} from "./playback.fixture";
import { createExportRenderer } from "./exportRendering";
import { finalizeWebmDuration } from "./webmDuration";
import {
  exportRecording,
  recordingExportProblem,
  webmExportType,
} from "./recordingCapture";

vi.mock("./exportRendering", () => ({ createExportRenderer: vi.fn() }));
vi.mock("./webmDuration", () => ({
  finalizeWebmDuration: vi.fn(async (blob: Blob) => blob),
}));

// Development fixtures exercise the capture clock, never substitute API output.
const result = {
  ...fixture,
  frames: [5, 10, 20].map((step) => ({ step, agents: [] })),
};
const options = {
  resolution: 720 as const,
  includeHeatmap: true,
  showAgentNumbers: false,
};

describe("recording export eligibility", () => {
  it("accepts irregular recorded steps and unfinished evacuation outcomes", () => {
    expect(recordingExportProblem(building, result)).toBeNull();
    expect(
      recordingExportProblem(building, { ...result, status: "timeout" }),
    ).toBeNull();
  });
  it("rejects synthetic previews, missing, empty, single-frame and mismatched recordings", () => {
    expect(recordingExportProblem(building, result, true)).toMatch(/Synthetic/);
    expect(recordingExportProblem(building, null)).toMatch(/Run a simulation/);
    for (const frames of [[], [result.frames[0]!]])
      expect(recordingExportProblem(building, { ...result, frames })).toMatch(
        /two recorded frames/,
      );
    expect(recordingExportProblem({ ...building, width: 100 }, result)).toMatch(
      /match/,
    );
  });
  it("rejects invalid or unordered timestamps", () => {
    for (const time_step_seconds of [0, -1, NaN, Infinity])
      expect(
        recordingExportProblem(building, { ...result, time_step_seconds }),
      ).toMatch(/timestamps/);
    for (const steps of [
      [0, 0],
      [3, 2],
      [-1, 2],
      [0, Infinity],
    ])
      expect(
        recordingExportProblem(building, {
          ...result,
          frames: steps.map((step) => ({ step, agents: [] })),
        }),
      ).toMatch(/timestamps/);
  });
});

describe("native Canvas recording", () => {
  let draw = vi.fn<(seconds: number) => void>();
  let track: {
    stop: ReturnType<typeof vi.fn>;
    requestFrame: ReturnType<typeof vi.fn>;
  };
  let canvas: {
    dataset: object;
    style: object;
    setAttribute: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    getContext: ReturnType<typeof vi.fn>;
    captureStream: ReturnType<typeof vi.fn>;
  };
  let doc: EventTarget & {
    hidden: boolean;
    body: { append: ReturnType<typeof vi.fn> };
    createElement: ReturnType<typeof vi.fn>;
  };
  let callbacks: Map<number, FrameRequestCallback>, id: number;
  class Recorder {
    static instances: Recorder[] = [];
    static isTypeSupported = vi.fn(() => true);
    state = "inactive";
    mimeType = "video/webm;codecs=vp8";
    onstart: (() => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    constructor() {
      Recorder.instances.push(this);
    }
    start() {
      this.state = "recording";
      this.onstart?.();
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(["encoded frames"]) });
        this.onstop?.();
      });
    }
  }
  function tick(now: number) {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((callback) => callback(now));
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    callbacks = new Map();
    id = 0;
    draw = vi.fn();
    vi.mocked(createExportRenderer).mockReturnValue(draw);
    track = { stop: vi.fn(), requestFrame: vi.fn() };
    canvas = {
      dataset: {},
      style: {},
      setAttribute: vi.fn(),
      remove: vi.fn(),
      getContext: vi.fn(() => ({})),
      captureStream: vi.fn(() => ({
        getTracks: () => [track],
        getVideoTracks: () => [track],
      })),
    };
    doc = Object.assign(new EventTarget(), {
      hidden: false,
      body: { append: vi.fn() },
      createElement: vi.fn(() => canvas),
    });
    Recorder.instances = [];
    Recorder.isTypeSupported.mockReset().mockReturnValue(true);
    vi.stubGlobal("document", doc);
    vi.stubGlobal(
      "HTMLCanvasElement",
      class {
        captureStream() {}
      },
    );
    vi.stubGlobal("MediaRecorder", Recorder);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.set(++id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (key: number) =>
      callbacks.delete(key),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  it.each([720, 1080] as const)(
    "exports the full %ip recording at 1x from its actual first step, waits for final data, and releases capture resources",
    async (resolution) => {
      const progress = vi.fn(),
        before = JSON.stringify(result),
        controller = new AbortController();
      const promise = exportRecording(
        building,
        result,
        { ...options, resolution },
        controller.signal,
        progress,
      );
      expect(canvas.style).toMatchObject({
        width: resolution === 720 ? "1280px" : "1920px",
        height: `${resolution}px`,
      });
      expect(draw).toHaveBeenLastCalledWith(0.5);
      tick(500);
      expect(draw).toHaveBeenLastCalledWith(1);
      tick(1400);
      expect(draw).toHaveBeenLastCalledWith(1.9);
      tick(1500);
      expect(draw).toHaveBeenLastCalledWith(2);
      await vi.advanceTimersByTimeAsync(40);
      const blob = await promise;
      expect(await blob.text()).toBe("encoded frames");
      expect(finalizeWebmDuration).toHaveBeenCalledWith(blob, 1.5);
      expect(progress).toHaveBeenLastCalledWith(1);
      expect(createExportRenderer).toHaveBeenCalledWith(
        canvas,
        building,
        result,
        { ...options, resolution },
      );
      expect(track.stop).toHaveBeenCalledOnce();
      expect(canvas.remove).toHaveBeenCalledOnce();
      expect(callbacks.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(JSON.stringify(result)).toBe(before);
    },
  );
  it("cancels without a file and stops recorder, tracks, timers and animation", async () => {
    const controller = new AbortController();
    const promise = exportRecording(
      building,
      result,
      options,
      controller.signal,
      vi.fn(),
    );
    const rejected = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    tick(100);
    controller.abort();
    await rejected;
    expect(Recorder.instances[0]!.state).toBe("inactive");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(canvas.remove).toHaveBeenCalledOnce();
    expect(callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["hidden", "stall", "encoder"])(
    "cleans up on %s failures",
    async (failure) => {
      const promise = exportRecording(
        building,
        result,
        options,
        new AbortController().signal,
        vi.fn(),
      );
      const rejected = expect(promise).rejects.toThrow();
      if (failure === "hidden") {
        doc.hidden = true;
        doc.dispatchEvent(new Event("visibilitychange"));
      }
      if (failure === "stall") tick(2000);
      if (failure === "encoder") Recorder.instances[0]!.onerror?.();
      await rejected;
      expect(track.stop).toHaveBeenCalledOnce();
      expect(canvas.remove).toHaveBeenCalledOnce();
      expect(callbacks.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("handles missing encoders/capture APIs and falls back to a supported WebM codec", async () => {
    Recorder.isTypeSupported.mockImplementation(
      (...args: unknown[]) => args[0] === "video/webm",
    );
    expect(webmExportType()).toBe("video/webm");
    Recorder.isTypeSupported.mockReturnValue(false);
    expect(webmExportType()).toBeNull();
    await expect(
      exportRecording(
        building,
        result,
        options,
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow(/cannot export WebM/);
    expect(doc.createElement).not.toHaveBeenCalled();
    vi.stubGlobal("MediaRecorder", undefined);
    expect(webmExportType()).toBeNull();
  });
});
