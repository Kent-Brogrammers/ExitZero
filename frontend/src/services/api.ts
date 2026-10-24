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
    metrics.trapped > metrics.remaining
  ) {
    throw new ApiError(
      200,
      "invalid_response",
      "Backend returned inconsistent population totals.",
    );
  }
}

function checkSimulation(result: SimulationResult): SimulationResult {
  checkMetrics(result);
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
    )
  )
    throw new ApiError(
      200,
      "invalid_response",
      "Backend returned invalid traffic or animation frames.",
    );
  return result;
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
      return checkSimulation(result);
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
          const result = checkSimulation(event.result);
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
