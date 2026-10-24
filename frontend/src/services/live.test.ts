import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./api";
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
