import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
import schema from "../../../shared/schemas/contracts.schema.json";
import mock from "../../../shared/examples/simulation.mock.json";
import { buildingError } from "../editor/geometry";
import {
  createPlayback,
  frameIndexAtTime,
  PLAYBACK_SPEEDS,
  type AnimationClock,
} from "./playback";
import { syntheticBuilding, syntheticResult } from "./playback.fixture";

function testClock() {
  let now = 0;
  let id = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const clock: AnimationClock = {
    now: () => now,
    request: (callback) => {
      pending.set(++id, callback);
      return id;
    },
    cancel: (handle) => {
      pending.delete(handle);
    },
  };
  return {
    clock,
    pending,
    advance: (milliseconds: number) => {
      now += milliseconds;
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((callback) => callback(now));
    },
  };
}

function setup() {
  const timer = testClock();
  return { ...timer, player: createPlayback(syntheticResult, timer.clock) };
}

describe("recorded simulation playback", () => {
  it("starts paused at the first frame", () => {
    const { player, pending } = setup();
    expect(player.getSnapshot()).toEqual({
      index: 0,
      playing: false,
      speed: 1,
      started: false,
    });
    expect(pending.size).toBe(0);
  });

  it("uses nonuniform frame steps and time_step_seconds instead of frame count", () => {
    const { player, advance } = setup();
    player.play();
    advance(999);
    expect(player.getSnapshot().index).toBe(0);
    advance(1);
    expect(player.getSnapshot().index).toBe(1);
    advance(1499);
    expect(player.getSnapshot().index).toBe(1);
    advance(1);
    expect(player.getSnapshot().index).toBe(2);
  });

  it("keeps subframe progress through pause and resume without counting paused wall time", () => {
    const { player, advance, pending } = setup();
    player.play();
    advance(400);
    player.pause();
    expect(player.getSnapshot()).toMatchObject({
      playing: false,
      started: true,
    });
    expect(pending.size).toBe(0);
    advance(10000);
    expect(player.getSnapshot().index).toBe(0);
    player.play();
    advance(599);
    expect(player.getSnapshot().index).toBe(0);
    advance(1);
    expect(player.getSnapshot().index).toBe(1);
  });

  it("does not queue duplicate animations when Play is pressed twice", () => {
    const { player, pending } = setup();
    player.play();
    player.play();
    expect(pending.size).toBe(1);
  });

  it("resets and pauses at the first frame while preserving selected speed", () => {
    const { player, advance, pending } = setup();
    player.setSpeed(2);
    player.play();
    advance(1500);
    expect(player.getSnapshot().index).toBe(2);
    player.reset();
    expect(player.getSnapshot()).toEqual({
      index: 0,
      playing: false,
      speed: 2,
      started: false,
    });
    expect(pending.size).toBe(0);
    player.play();
    advance(499);
    expect(player.getSnapshot().index).toBe(0);
    advance(1);
    expect(player.getSnapshot().index).toBe(1);
  });

  it("seeks to available frames, pauses, and resumes from their actual timestamps", () => {
    const { player, advance, pending } = setup();
    player.play();
    player.seek(2);
    expect(player.getSnapshot()).toMatchObject({ index: 2, playing: false });
    expect(pending.size).toBe(0);
    player.play();
    advance(1999);
    expect(player.getSnapshot().index).toBe(2);
    advance(1);
    expect(player.getSnapshot().index).toBe(3);
    player.seek(999);
    expect(player.getSnapshot().index).toBe(4);
    player.seek(-2);
    expect(player.getSnapshot().index).toBe(0);
    player.seek(NaN);
    expect(player.getSnapshot().index).toBe(0);
  });

  it("applies speed changes from the change instant without losing prior progress", () => {
    const { player, advance } = setup();
    player.play();
    advance(400);
    player.setSpeed(2);
    advance(299);
    expect(player.getSnapshot().index).toBe(0);
    advance(1);
    expect(player.getSnapshot().index).toBe(1);
  });

  it.each(PLAYBACK_SPEEDS)("supports the %s× speed selection", (speed) => {
    const { player, advance } = setup();
    player.setSpeed(speed);
    player.play();
    advance(1000 / speed);
    expect(player.getSnapshot()).toMatchObject({ speed, index: 1 });
  });

  it.each([0, -1, 3, Infinity, NaN])(
    "ignores unsupported playback speed %s",
    (speed) => {
      const { player } = setup();
      player.setSpeed(speed);
      expect(player.getSnapshot().speed).toBe(1);
    },
  );

  it("stops at the end, including when a long animation interval skips frames, and can replay", () => {
    const { player, advance, pending } = setup();
    player.play();
    advance(20000);
    expect(player.getSnapshot()).toMatchObject({ index: 4, playing: false });
    expect(pending.size).toBe(0);
    player.play();
    expect(player.getSnapshot()).toMatchObject({ index: 0, playing: true });
    expect(pending.size).toBe(1);
  });

  it.each(["incomplete", "timeout"] as const)(
    "ends a %s recording without altering its outcome",
    (status) => {
      const timer = testClock();
      const result = { ...mock, status };
      const player = createPlayback(result, timer.clock);
      player.play();
      timer.advance(100);
      expect(player.getSnapshot()).toMatchObject({ index: 1, playing: false });
      expect(result.status).toBe(status);
      expect(result.clearance_steps).toBeNull();
      expect(result.remaining).toBe(1);
    },
  );

  it.each([
    null,
    { ...syntheticResult, frames: [] },
    { ...syntheticResult, frames: [syntheticResult.frames[0]!] },
  ])("handles missing, empty, or single-frame results", (result) => {
    const timer = testClock();
    const player = createPlayback(result, timer.clock);
    player.play();
    player.seek(0);
    player.pause();
    player.reset();
    timer.advance(10000);
    expect(player.getSnapshot()).toMatchObject({ index: 0, playing: false });
    expect(timer.pending.size).toBe(0);
  });

  it("handles recordings starting at a nonzero simulation step", () => {
    const timer = testClock();
    const result = {
      ...syntheticResult,
      time_step_seconds: 0.25,
      frames: [
        { step: 10, agents: [] },
        { step: 12, agents: [] },
      ],
    };
    const player = createPlayback(result, timer.clock);
    player.play();
    timer.advance(499);
    expect(player.getSnapshot().index).toBe(0);
    timer.advance(1);
    expect(player.getSnapshot()).toMatchObject({ index: 1, playing: false });
  });

  it("cleans up animation requests on unmount or result replacement and starts the new result afresh", () => {
    const { player, advance, pending, clock } = setup();
    const listener = vi.fn();
    const unsubscribe = player.subscribe(listener);
    player.play();
    advance(1000);
    player.setSpeed(4);
    player.dispose();
    unsubscribe();
    const previousCalls = listener.mock.calls.length;
    expect(pending.size).toBe(0);
    advance(10000);
    expect(listener).toHaveBeenCalledTimes(previousCalls);
    const replacement = createPlayback({ ...syntheticResult }, clock);
    expect(replacement.getSnapshot()).toEqual({
      index: 0,
      playing: false,
      speed: 1,
      started: false,
    });
    // React StrictMode can remount the same controller after effect cleanup.
    player.play();
    expect(player.getSnapshot().playing).toBe(true);
    player.dispose();
  });

  it("retains a stable store snapshot between frame changes", () => {
    const { player, advance } = setup();
    player.play();
    const state = player.getSnapshot();
    advance(100);
    expect(player.getSnapshot()).toBe(state);
  });
});

describe("frame timestamps and development fixture", () => {
  it("finds frames by simulation timestamps at bounds and between frames", () => {
    const frames = syntheticResult.frames;
    expect(frameIndexAtTime([], 0.1, 0)).toBe(-1);
    expect(frameIndexAtTime(frames, 0.1, -1)).toBe(0);
    expect(frameIndexAtTime(frames, 0.1, 2.49)).toBe(1);
    expect(frameIndexAtTime(frames, 0.1, 2.5)).toBe(2);
    expect(frameIndexAtTime(frames, 0.1, 999)).toBe(4);
  });

  it("uses a valid separate layout and result matching the existing shared contracts", () => {
    const ajv = new Ajv({ allErrors: true });
    ajv.addSchema(schema);
    expect(buildingError(syntheticBuilding)).toBeNull();
    const validate = ajv.getSchema(`${schema.$id}#/$defs/SimulationResult`)!;
    expect(validate(syntheticResult), JSON.stringify(validate.errors)).toBe(
      true,
    );
    expect(syntheticResult.width).toBe(syntheticBuilding.width);
    expect(syntheticResult.height).toBe(syntheticBuilding.height);
    expect(
      syntheticBuilding.spawn_zones.reduce(
        (total, zone) => total + zone.count,
        0,
      ),
    ).toBe(syntheticResult.total_population);
  });
});
