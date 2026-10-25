import { afterEach, describe, expect, it, vi } from "vitest";
import building from "../../../shared/examples/building.json";
import mock from "../../../shared/examples/simulation.mock.json";
import { ApiError, createApiClient } from "./api";

const client = createApiClient("http://localhost:3001/api/");
const stressRequest = {
  building,
  config: {
    max_scenarios: 10,
    block_each_exit: true,
    obstruction_candidates: [],
  },
};

function respond(body: unknown, status = 200) {
  return vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("API integration contract", () => {
  it("accepts explicit window route counts and rejects inconsistent totals or queue IDs", async () => {
    // Synthetic contract test data only; the API never manufactures these outcomes.
    const result = {
      ...mock,
      evacuated_by_route: {
        normal_exit: mock.evacuated - 1,
        emergency_window: 1,
      },
    };
    respond(result);
    await expect(client.simulate(building)).resolves.toEqual(result);
    respond({
      ...result,
      evacuated_by_route: { normal_exit: 0, emergency_window: 0 },
    });
    await expect(client.simulate(building)).rejects.toMatchObject({
      code: "invalid_response",
    });
    respond({
      ...result,
      frames: [
        {
          ...mock.frames[0],
          window_states: [
            {
              window_id: "pane",
              state: "opening",
              preparation_ready_step: 10,
              queue_agent_ids: [4294967295],
              traversing_agent_id: null,
              traversal_earliest_finish_step: null,
            },
          ],
        },
      ],
    });
    await expect(client.simulate(building)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
  it("reads health and normalizes the base URL", async () => {
    respond({ status: "ok", service: "exitzero" });
    await expect(client.health()).resolves.toEqual({
      status: "ok",
      service: "exitzero",
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("uses the same-origin proxy by default", async () => {
    respond({ status: "ok", service: "exitzero" });
    await createApiClient().health();
    expect(fetch).toHaveBeenCalledWith("/api/health", expect.any(Object));
  });

  it("rejects a health response with the wrong service", async () => {
    respond({ status: "ok", service: "another-service" });
    await expect(client.health()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("sends snake_case building JSON and accepts a valid simulation fixture", async () => {
    respond(mock);
    await expect(client.simulate(building)).resolves.toEqual(mock);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/simulate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(building),
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("preserves structured 501 errors on all computation endpoints", async () => {
    respond(
      {
        error: { code: "not_implemented", message: "No computation has run." },
      },
      501,
    );
    for (const run of [
      () => client.simulate(building),
      () => client.stressTest(stressRequest),
      () => client.optimize({ building, max_candidates: 10 }),
    ]) {
      await expect(run()).rejects.toMatchObject({
        status: 501,
        code: "not_implemented",
        message: "No computation has run.",
      });
    }
  });

  it("preserves validation errors", async () => {
    respond(
      { error: { code: "validation_error", message: "Invalid spawn count." } },
      422,
    );
    await expect(client.simulate(building)).rejects.toMatchObject({
      status: 422,
      code: "validation_error",
    });
  });

  it("handles unstructured HTTP errors", async () => {
    respond({ unexpected: true }, 503);
    await expect(client.health()).rejects.toMatchObject({
      status: 503,
      code: "http_error",
    });
  });

  it("rejects HTML responses with a typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>Server error</html>", { status: 502 }),
        ),
    );
    await expect(client.health()).rejects.toMatchObject({
      status: 502,
      code: "invalid_response",
    });
  });

  it("reports network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    await expect(client.health()).rejects.toBeInstanceOf(ApiError);
    await expect(client.health()).rejects.toMatchObject({
      status: 0,
      code: "network_error",
    });
  });

  it("preserves cancellation instead of reporting an offline backend", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    await expect(client.health(controller.signal)).rejects.toBe(error);
  });

  it("rejects results that falsely claim completion", async () => {
    respond({ ...mock, status: "completed" });
    await expect(client.simulate(building)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects inconsistent totals, traffic positions, and frames", async () => {
    for (const invalid of [
      { ...mock, evacuated: 2 },
      { ...mock, trapped: 2 },
      { ...mock, traffic_samples: [{ x: 99, y: 0, visits: 1 }] },
      { ...mock, frames: [{ step: 0, agents: [{ id: 0, x: 99, y: 0 }] }] },
      {
        ...mock,
        frames: [
          { step: 0, agents: [] },
          { step: 0, agents: [] },
        ],
      },
      {
        ...mock,
        frames: [
          {
            step: 0,
            agents: [
              { id: 0, x: 1, y: 1 },
              { id: 0, x: 2, y: 1 },
            ],
          },
        ],
      },
    ]) {
      respond(invalid);
      await expect(client.simulate(building)).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });

  it("accepts typed stress and optimization responses", async () => {
    const baseline = {
      status: "incomplete",
      total_population: 2,
      evacuated: 1,
      remaining: 1,
      trapped: 1,
      clearance_steps: null,
    };
    const stress = {
      baseline,
      scenarios: [
        {
          scenario_id: "block-west",
          description: "West exit blocked",
          modifications: { blocked_exit_ids: ["west"], added_obstructions: [] },
          metrics: baseline,
          rank: 1,
          severity: "critical",
        },
      ],
    };
    respond(stress);
    await expect(client.stressTest(stressRequest)).resolves.toEqual(stress);
    const optimization = { baseline, candidates: [] };
    respond(optimization);
    await expect(
      client.optimize({ building, max_candidates: 10 }),
    ).resolves.toEqual(optimization);
  });
});
