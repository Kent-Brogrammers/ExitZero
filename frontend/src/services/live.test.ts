import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./api";
import type { BuildingScenario } from "../types/simulation";
import {
  syntheticBuilding as building,
  syntheticResult as result,
} from "../simulation/playback.fixture";

const client = createApiClient();
const encode = (event: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(event)}\n`);
function respond(stream: ReadableStream<Uint8Array>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(stream, {
        headers: { "Content-Type": "application/x-ndjson" },
      }),
    ),
  );
}
function streamEvents(events: unknown[]) {
  respond(
    new ReadableStream({
      start(controller) {
        events.forEach((event) => controller.enqueue(encode(event)));
        controller.close();
      },
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("live simulation transport", () => {
  it("delivers the first frame while the run is still pending, then returns its recording", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    respond(
      new ReadableStream({
        start(value) {
          controller = value;
        },
      }),
    );
    const onFrame = vi.fn();
    let completed = false;
    const run = client.simulateLive(building, onFrame).then((recording) => {
      completed = true;
      return recording;
    });
    controller.enqueue(encode({ type: "frame", frame: result.frames[0] }));
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1));
    expect(completed).toBe(false);
    result.frames
      .slice(1)
      .forEach((frame) => controller.enqueue(encode({ type: "frame", frame })));
    controller.enqueue(encode({ type: "complete", result }));
    controller.close();
    await expect(run).resolves.toEqual(result);
    expect(onFrame).toHaveBeenCalledTimes(result.frames.length);
    expect(fetch).toHaveBeenCalledWith(
      "/api/simulate/live",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(building),
      }),
    );
  });

  it("parses split JSON and multiple events in one network chunk", async () => {
    const events = [
      ...result.frames.map((frame) => ({ type: "frame", frame })),
      { type: "complete", result },
    ];
    const data = new TextEncoder().encode(
      events.map((event) => JSON.stringify(event)).join("\n"),
    );
    respond(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < data.length; i += 17)
            controller.enqueue(data.slice(i, i + 17));
          controller.close();
        },
      }),
    );
    await expect(client.simulateLive(building, vi.fn())).resolves.toEqual(
      result,
    );
  });

  it("delivers every backend congestion increment when frames share a network chunk", async () => {
    const samples = [
      { x: 1.25, y: 1.5, crowd_delay_seconds: 0.25 },
      { x: 2.75, y: 1.5, crowd_delay_seconds: 0.5 },
    ];
    const recording = {
      ...result,
      congestion_samples: samples,
      frames: result.frames.map((frame, index) => ({
        ...frame,
        congestion_samples:
          index === 1 ? [samples[0]!] : index === 2 ? [samples[1]!] : [],
      })),
    };
    const events = [
      ...recording.frames.map((frame) => ({ type: "frame", frame })),
      { type: "complete", result: recording },
    ];
    respond(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              events.map((event) => JSON.stringify(event)).join("\n"),
            ),
          );
          controller.close();
        },
      }),
    );
    const onFrame = vi.fn();
    await expect(client.simulateLive(building, onFrame)).resolves.toEqual(
      recording,
    );
    expect(onFrame).toHaveBeenCalledTimes(recording.frames.length);
    expect(
      onFrame.mock.calls.flatMap(([frame]) => frame.congestion_samples),
    ).toEqual(samples);
  });

  it.each([
    { x: 4.01, y: 1, crowd_delay_seconds: 0.1 },
    { x: 1, y: 3.01, crowd_delay_seconds: 0.1 },
    { x: 1, y: 1, crowd_delay_seconds: -0.1 },
    { x: 1, y: 1, crowd_delay_seconds: Infinity },
  ])(
    "rejects invalid congestion increments before delivering a live frame %#",
    async (sample) => {
      streamEvents([
        {
          type: "frame",
          frame: { ...result.frames[0]!, congestion_samples: [] },
        },
        {
          type: "frame",
          frame: { ...result.frames[1]!, congestion_samples: [sample] },
        },
      ]);
      const onFrame = vi.fn();
      await expect(
        client.simulateLive(building, onFrame),
      ).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(onFrame).toHaveBeenCalledOnce();
    },
  );

  describe.each(["exact-only", "mixed"])("%s occupant population", (source) => {
    function scenario(): BuildingScenario {
      const next = structuredClone(building);
      // The scripted transport recording has two occupants. In mixed mode,
      // ID 0 is exact and ID 1 comes from the eastern spawn zone.
      next.spawn_zones = source === "mixed" ? next.spawn_zones.slice(1) : [];
      next.placed_occupants = result.frames[0]!.agents.slice(
        0,
        source === "mixed" ? 1 : 2,
      ).map((agent) => ({
        id: `placed-${agent.id}`,
        x: agent.x,
        y: agent.y,
      }));
      return next;
    }

    it("accepts all initial occupants and preserves exact centres in the request", async () => {
      const next = scenario();
      const original = structuredClone(next);
      streamEvents([
        ...result.frames.map((frame) => ({ type: "frame", frame })),
        { type: "complete", result },
      ]);
      const onFrame = vi.fn();
      await expect(client.simulateLive(next, onFrame)).resolves.toEqual(result);
      expect(onFrame).toHaveBeenNthCalledWith(1, result.frames[0]);
      expect(fetch).toHaveBeenCalledWith(
        "/api/simulate/live",
        expect.objectContaining({ body: JSON.stringify(original) }),
      );
      expect(next).toEqual(original);
    });

    it("rejects an initial frame that omits an occupant", async () => {
      streamEvents([
        {
          type: "frame",
          frame: { step: 0, agents: result.frames[0]!.agents.slice(1) },
        },
      ]);
      await expect(
        client.simulateLive(scenario(), vi.fn()),
      ).rejects.toMatchObject({ code: "invalid_response" });
    });

    it("rejects a completed recording with a different population", async () => {
      streamEvents([
        ...result.frames.map((frame) => ({ type: "frame", frame })),
        {
          type: "complete",
          result: {
            ...result,
            total_population: 1,
            evacuated: 1,
            frames: result.frames.map((frame) => ({
              ...frame,
              agents: frame.agents.filter((agent) => agent.id === 0),
            })),
          },
        },
      ]);
      await expect(
        client.simulateLive(scenario(), vi.fn()),
      ).rejects.toMatchObject({ code: "invalid_response" });
    });
  });

  it("does not mistake an interrupted stream for a completed recording", async () => {
    streamEvents([{ type: "frame", frame: result.frames[0] }]);
    await expect(client.simulateLive(building, vi.fn())).rejects.toMatchObject({
      code: "stream_interrupted",
    });
  });

  it.each([
    [{ type: "frame", frame: { step: 0, agents: [{ id: 0, x: 99, y: 1 }] } }],
    [
      { type: "frame", frame: result.frames[0] },
      { type: "frame", frame: result.frames[0] },
    ],
    [
      { type: "frame", frame: result.frames[0] },
      { type: "frame", frame: { step: 1, agents: [{ id: 99, x: 1, y: 1 }] } },
    ],
    [{ type: "complete", result }],
    [
      { type: "frame", frame: result.frames[0] },
      { type: "complete", result },
    ],
    [{ type: "something_else" }],
  ])("rejects malformed or inconsistent live events %#", async (...events) => {
    streamEvents(events);
    await expect(client.simulateLive(building, vi.fn())).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("surfaces simulation errors after the stream has opened", async () => {
    streamEvents([
      {
        type: "error",
        error: { code: "validation_error", message: "Cannot place occupants." },
      },
    ]);
    await expect(client.simulateLive(building, vi.fn())).rejects.toMatchObject({
      message: "Cannot place occupants.",
    });
  });

  it("cancels the reader when validation fails", async () => {
    const cancel = vi.fn();
    respond(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encode({ bad: "data" }));
        },
        cancel,
      }),
    );
    await expect(client.simulateLive(building, vi.fn())).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
