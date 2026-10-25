import Ajv, { type ValidateFunction } from "ajv";
import contracts from "../../../shared/schemas/contracts.schema.json";
import type {
  ApiErrorResponse,
  AnimationFrame,
  BuildingScenario,
  HealthResponse,
  OptimizationResult,
  OptimizeRequest,
  SimulationMetrics,
  SimulationResult,
  SimulationStreamEvent,
  StressTestRequest,
  StressTestResult,
} from "../types/simulation";

const ajv = new Ajv({ allErrors: true });
ajv.addSchema(contracts);

function validator<T>(name: string): ValidateFunction<T> {
  const validate = ajv.getSchema<T>(`${contracts.$id}#/$defs/${name}`);
  if (!validate) throw new Error(`Missing shared schema: ${name}`);
  return validate;
}

const validateHealth = validator<HealthResponse>("HealthResponse");
const validateSimulation = validator<SimulationResult>("SimulationResult");
const validateStreamEvent = validator<SimulationStreamEvent>(
  "SimulationStreamEvent",
);
const validateStress = validator<StressTestResult>("StressTestResult");
const validateOptimization =
  validator<OptimizationResult>("OptimizationResult");
const validateError = validator<ApiErrorResponse>("ApiErrorResponse");

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function checkMetrics(metrics: SimulationMetrics): void {
  if (
    metrics.evacuated + metrics.remaining !== metrics.total_population ||
    metrics.trapped > metrics.remaining ||
    (metrics.evacuated_by_route &&
      metrics.evacuated_by_route.normal_exit +
        metrics.evacuated_by_route.emergency_window !==
        metrics.evacuated)
  ) {
    throw new ApiError(
      200,
      "invalid_response",
      "Backend returned inconsistent population totals.",
    );
  }
}

function checkSimulation(
  result: SimulationResult,
  building: BuildingScenario,
): SimulationResult {
  checkMetrics(result);
  if (result.communication_events) {
    const ids = new Set([
      ...(result.frames[0]?.agents.map((a) => a.id) ?? []),
      ...(result.analytics?.agents.map((a) => a.id) ?? []),
    ]);
    const openings = new Set(
      [...building.doors, ...building.exits].map((o) => o.id),
    );
    const lastStep = result.frames.at(-1)?.step ?? -1;
    const seen = new Set<string>();
    let previousStep = 0;
    for (const event of result.communication_events) {
      const key = JSON.stringify([
        event.step,
        event.event_type ?? "shared",
        event.sender_id,
        event.opening_id,
      ]);
      if (
        event.step < previousStep ||
        event.step > lastStep ||
        seen.has(key) ||
        !ids.has(event.sender_id) ||
        !openings.has(event.opening_id) ||
        event.recipient_ids.includes(event.sender_id) ||
        event.recipient_ids.some((id) => !ids.has(id))
      )
        throw new ApiError(
          200,
          "invalid_response",
          "Backend returned invalid communication event references or timing.",
        );
      seen.add(key);
      previousStep = event.step;
    }
  }
  if (
    result.analytics?.agents.some((a) => {
      const route = a.escape_route;
      if (!route) return false;
      return (
        a.evacuation_step === null ||
        (route.kind === "normal_exit"
          ? a.exit_id !== route.opening_id ||
            !building.exits.some((e) => e.id === route.opening_id)
          : a.exit_id !== null ||
            !building.windows?.some((w) => w.id === route.opening_id))
      );
    }) ||
    result.frames.some((f) =>
      f.window_states?.some(
        (s) => !building.windows?.some((w) => w.id === s.window_id),
      ),
    )
  )
    throw new ApiError(
      200,
      "invalid_response",
      "Backend returned invalid window or escape route references.",
    );
  if (
    result.analytics &&
    result.evacuated_by_route &&
    result.analytics.agents.filter(
      (a) => a.escape_route?.kind === "emergency_window",
    ).length !== result.evacuated_by_route.emergency_window
  )
    throw new ApiError(
      200,
      "invalid_response",
      "Backend returned inconsistent escape route outcomes.",
    );
  if (
    result.traffic_samples.some(
      (sample) => sample.x > result.width || sample.y > result.height,
    ) ||
    result.frames.some(
      (frame, index) =>
        (index > 0 && frame.step <= result.frames[index - 1]!.step) ||
        frame.agents.length > result.total_population ||
        new Set(frame.agents.map((agent) => agent.id)).size !==
          frame.agents.length ||
        frame.agents.some(
          (agent) => agent.x > result.width || agent.y > result.height,
        ),
      // Queue/service membership must reference occupants present at that timestamp.
    ) ||
    result.frames.some((frame) => !validWindowStates(frame))
  )
    throw new ApiError(
      200,
      "invalid_response",
      "Backend returned invalid traffic or animation frames.",
    );
  return result;
}

function validWindowStates(frame: AnimationFrame): boolean {
  const ids = new Set(frame.agents.map((a) => a.id)),
    windows = new Set<string>(),
    members = new Set<number>();
  return (frame.window_states ?? []).every((s) => {
    if (
      windows.has(s.window_id) ||
      (s.traversing_agent_id !== null) !==
        (s.traversal_earliest_finish_step !== null) ||
      (s.traversing_agent_id !== null &&
        s.state !== "open" &&
        s.state !== "broken") ||
      ((s.state === "opening" || s.state === "breaking") &&
        s.preparation_ready_step === null)
    )
      return false;
    windows.add(s.window_id);
    return [
      ...s.queue_agent_ids,
      ...(s.traversing_agent_id === null ? [] : [s.traversing_agent_id]),
    ].every((id) => {
      if (!ids.has(id) || members.has(id)) return false;
      members.add(id);
      return true;
    });
  });
}

// Default uses Vite's /api proxy. A direct backend URL is also supported.
export function createApiClient(
  baseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api",
) {
  async function request<T>(
    path: string,
    validate: ValidateFunction<T>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers:
          body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError(
        0,
        "network_error",
        "Cannot reach the backend. Start the Rust server and retry.",
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(
        response.status,
        "invalid_response",
        "Backend returned a non-JSON response.",
      );
    }
    if (!response.ok) {
      if (validateError(data))
        throw new ApiError(
          response.status,
          data.error.code,
          data.error.message,
        );
      throw new ApiError(
        response.status,
        "http_error",
        `Request failed (HTTP ${response.status}).`,
      );
    }
    if (!validate(data)) {
      throw new ApiError(
        response.status,
        "invalid_response",
        "Backend response does not match the shared contract.",
      );
    }
    return data;
  }

  return {
    health: (signal?: AbortSignal) =>
      request("/health", validateHealth, undefined, signal),
    simulate: async (building: BuildingScenario): Promise<SimulationResult> => {
      const result = await request("/simulate", validateSimulation, building);
      return checkSimulation(result, building);
    },
    simulateLive: async (
      building: BuildingScenario,
      onFrame: (frame: AnimationFrame) => void,
      signal?: AbortSignal,
    ): Promise<SimulationResult> => {
      let response: Response;
      try {
        response = await fetch(`${baseUrl.replace(/\/$/, "")}/simulate/live`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/x-ndjson",
          },
          body: JSON.stringify(building),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new ApiError(
          0,
          "network_error",
          "Cannot reach the backend. Start the Rust server and retry.",
        );
      }
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => null);
        if (validateError(data))
          throw new ApiError(
            response.status,
            data.error.code,
            data.error.message,
          );
        throw new ApiError(
          response.status,
          "http_error",
          `Request failed (HTTP ${response.status}).`,
        );
      }
      if (
        !response.body ||
        !response.headers.get("content-type")?.includes("application/x-ndjson")
      ) {
        throw new ApiError(
          200,
          "invalid_response",
          "Backend did not return a live simulation stream.",
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "";
      let lastStep = -1;
      let previousIds: Set<number> | null = null;
      const population = building.spawn_zones.reduce(
        (sum, zone) => sum + zone.count,
        0,
      );
      function accept(line: string): SimulationResult | null {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          throw new ApiError(
            200,
            "invalid_response",
            "Backend returned malformed live data.",
          );
        }
        if (!validateStreamEvent(event))
          throw new ApiError(
            200,
            "invalid_response",
            "Live data does not match the shared contract.",
          );
        if (event.type === "error")
          throw new ApiError(200, event.error.code, event.error.message);
        if (event.type === "complete") {
          const result = checkSimulation(event.result, building);
          if (
            lastStep < 0 ||
            result.width !== building.width ||
            result.height !== building.height ||
            result.time_step_seconds !== building.time_step_seconds ||
            result.total_population !== population ||
            result.frames.at(-1)?.step !== lastStep
          ) {
            throw new ApiError(
              200,
              "invalid_response",
              "Live recording does not match the running scenario.",
            );
          }
          return result;
        }
        const frame = event.frame;
        const ids = new Set(frame.agents.map((agent) => agent.id));
        if (
          (lastStep < 0 && (frame.step !== 0 || ids.size !== population)) ||
          frame.step <= lastStep ||
          frame.step > building.max_steps ||
          ids.size !== frame.agents.length ||
          !validWindowStates(frame) ||
          (frame.window_states?.some(
            (s) => !building.windows?.some((w) => w.id === s.window_id),
          ) ??
            false) ||
          frame.agents.some(
            (agent) =>
              agent.x > building.width ||
              agent.y > building.height ||
              (previousIds !== null && !previousIds.has(agent.id)),
          )
        ) {
          throw new ApiError(
            200,
            "invalid_response",
            "Backend returned invalid live positions or timestamps.",
          );
        }
        lastStep = frame.step;
        previousIds = ids;
        onFrame(frame);
        return null;
      }
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const result = accept(line);
            if (result) return result;
          }
          if (done) {
            if (buffer.trim()) {
              const result = accept(buffer);
              if (result) return result;
            }
            throw new ApiError(
              0,
              "stream_interrupted",
              "The live run was interrupted before it finished. Run the scenario again.",
            );
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
    stressTest: async (
      payload: StressTestRequest,
    ): Promise<StressTestResult> => {
      const result = await request("/stress-test", validateStress, payload);
      checkMetrics(result.baseline);
      result.scenarios.forEach((scenario) => checkMetrics(scenario.metrics));
      return result;
    },
    optimize: async (payload: OptimizeRequest): Promise<OptimizationResult> => {
      const result = await request("/optimize", validateOptimization, payload);
      checkMetrics(result.baseline);
      result.candidates.forEach((candidate) => checkMetrics(candidate.metrics));
      return result;
    },
  };
}

export const api = createApiClient();
