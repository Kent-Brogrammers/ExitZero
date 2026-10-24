import Ajv, { type ValidateFunction } from "ajv";
import contracts from "../../../shared/schemas/contracts.schema.json";
import type {
  ApiErrorResponse,
  BuildingScenario,
  HealthResponse,
  OptimizationResult,
  OptimizeRequest,
  SimulationMetrics,
  SimulationResult,
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
      checkMetrics(result);
      if (
        result.cell_visits.length !== result.width * result.height ||
        result.frames.some(
          (frame, index) =>
            (index > 0 && frame.step <= result.frames[index - 1]!.step) ||
            frame.agents.length > result.total_population ||
            new Set(frame.agents.map((agent) => agent.id)).size !==
              frame.agents.length ||
            frame.agents.some(
              (agent) => agent.x >= result.width || agent.y >= result.height,
            ),
        )
      ) {
        throw new ApiError(
          200,
          "invalid_response",
          "Backend returned invalid traffic or animation frames.",
        );
      }
      return result;
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
