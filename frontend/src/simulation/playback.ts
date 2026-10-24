import type { AnimationFrame, SimulationResult } from "../types/simulation";

export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

export interface AnimationClock {
  now: () => number;
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
}

export interface PlaybackState {
  index: number;
  time: number;
  playing: boolean;
  speed: number;
  started: boolean;
}

const browserClock: AnimationClock = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};

/** Hold the last recorded frame until the next frame's actual simulation time. */
export function frameIndexAtTime(
  frames: AnimationFrame[],
  timeStepSeconds: number,
  seconds: number,
): number {
  if (!frames.length) return -1;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (frames[middle]!.step * timeStepSeconds <= seconds + 1e-9) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** A small recording player; it never calculates agent movement or navigation. */
export function createPlayback(
  result: SimulationResult | null,
  clock: AnimationClock = browserClock,
) {
  const frames = result?.frames ?? [];
  const timeStep = result?.time_step_seconds ?? 1;
  const firstTime = (frames[0]?.step ?? 0) * timeStep;
  const lastTime = (frames.at(-1)?.step ?? 0) * timeStep;
  let position = firstTime;
  let previousTime = 0;
  let animation: number | null = null;
  let state: PlaybackState = {
    index: 0,
    time: firstTime,
    playing: false,
    speed: 1,
    started: false,
  };
  const listeners = new Set<() => void>();
  const renderListeners = new Set<() => void>();
  const render = () => renderListeners.forEach((listener) => listener());

  function publish(next: PlaybackState, exact = false) {
    if (
      next.index === state.index &&
      next.playing === state.playing &&
      next.speed === state.speed &&
      next.started === state.started &&
      (next.time === state.time ||
        (!exact && Math.abs(next.time - state.time) < 0.1))
    )
      return;
    state = next;
    listeners.forEach((listener) => listener());
  }
  function cancel() {
    if (animation !== null) clock.cancel(animation);
    animation = null;
  }
  function advance(now: number) {
    if (!state.playing) return;
    position = Math.min(
      lastTime,
      position + (Math.max(0, now - previousTime) * state.speed) / 1000,
    );
    previousTime = now;
    const ended = position >= lastTime;
    if (ended) cancel();
    publish({
      ...state,
      index: frameIndexAtTime(frames, timeStep, position),
      time: position,
      playing: !ended,
    });
    render();
  }
  function tick(now: number) {
    animation = null;
    advance(now);
    if (state.playing) animation = clock.request(tick);
  }
  function play() {
    if (state.playing || frames.length < 2) return;
    if (position >= lastTime) position = firstTime;
    previousTime = clock.now();
    publish({
      ...state,
      index: frameIndexAtTime(frames, timeStep, position),
      time: position,
      playing: true,
      started: true,
    });
    render();
    animation = clock.request(tick);
  }
  function pause() {
    advance(clock.now());
    cancel();
    publish({ ...state, time: position, playing: false }, true);
  }
  function reset() {
    cancel();
    position = firstTime;
    publish(
      { ...state, index: 0, time: position, playing: false, started: false },
      true,
    );
    render();
  }
  function seek(index: number) {
    if (!frames.length || !Number.isFinite(index)) return;
    cancel();
    const next = Math.max(0, Math.min(frames.length - 1, Math.round(index)));
    position = frames[next]!.step * timeStep;
    publish(
      {
        ...state,
        index: next,
        time: position,
        playing: false,
        started: next > 0,
      },
      true,
    );
    render();
  }
  function setSpeed(speed: number) {
    if (!PLAYBACK_SPEEDS.some((value) => value === speed)) return;
    advance(clock.now());
    publish({ ...state, time: position, speed }, true);
  }
  return {
    getSnapshot: () => state,
    getTime: () => position,
    // Canvas updates on every animation tick; React time readouts are throttled.
    subscribeRender: (listener: () => void) => {
      renderListeners.add(listener);
      return () => {
        renderListeners.delete(listener);
      };
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    play,
    pause,
    reset,
    seek,
    step: (direction: -1 | 1) => seek(state.index + direction),
    setSpeed,
    // Cancels the current session. It can be mounted again by React StrictMode.
    dispose: () => {
      cancel();
      state = { ...state, playing: false };
    },
  };
}
