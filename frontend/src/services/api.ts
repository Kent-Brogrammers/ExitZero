import Ajv, { type ValidateFunction } from "ajv";
import { totalPopulation } from "../utils/population";
import contracts from "../../../shared/schemas/contracts.schema.json";
import type {
  ApiErrorResponse,
  ComputationCancellationResponse,
  JobRequest,
  JobSnapshot,
  JobList,
  ScenarioReplay,
  AnimationFrame,
  BuildingScenario,
  HealthResponse,
  OptimizationResult,
  PursuitEvent,
  OptimizeRequest,
  SimulationMetrics,
  SimulationResult,
  SimulationStreamEvent,
  LiveChatBatch,
  LiveSpeedControl,
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
const validateLiveSpeed = validator<LiveSpeedControl>("LiveSpeedControl");
const validateStress = validator<StressTestResult>("StressTestResult");
const validateOptimization =
  validator<OptimizationResult>("OptimizationResult");
const validateError = validator<ApiErrorResponse>("ApiErrorResponse");
const validateCancellation = validator<ComputationCancellationResponse>(
  "ComputationCancellationResponse",
);
const validateJob = validator<JobSnapshot>("JobSnapshot");
const validateJobs = validator<JobList>("JobList");
const validateJobRequest = validator<JobRequest>("JobRequest");
const validateReplay = validator<ScenarioReplay>("ScenarioReplay");

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
    metrics.evacuated + (metrics.sheltered ?? 0) + metrics.remaining !==
      metrics.total_population ||
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

function checkChat(
  events: Partial<LiveChatBatch>,
  building: BuildingScenario,
  ids: Set<number>,
  lastStep: number,
  firstStep = 0,
) {
  if (events.agent_events) {
    const exits = new Set(building.exits.map((e) => e.id));
    const windows = new Set(building.windows?.map((w) => w.id));
    const shelters = new Set(building.tornado_zones?.map((s) => s.id));
    const seen = new Set<string>();
    let previous = firstStep;
    for (const event of events.agent_events) {
      const key = JSON.stringify([
        event.step,
        event.kind,
        event.agent_id,
        event.subject_id,
      ]);
      const subject = event.subject_id ?? "";
      const validSubject = event.kind.startsWith("window_")
        ? windows.has(subject)
        : event.kind === "sheltered"
          ? shelters.has(subject)
          : event.kind === "evacuated"
            ? exits.has(subject) || windows.has(subject)
            : event.kind === "heading_to_exit" || event.kind === "rerouting"
              ? exits.has(subject) || shelters.has(subject)
              : event.subject_id === undefined;
      if (
        event.step < previous ||
        event.step > lastStep ||
        !ids.has(event.agent_id) ||
        !validSubject ||
        seen.has(key) ||
        (event.position &&
          (event.position.x > building.width ||
            event.position.y > building.height))
      ) {
        throw new ApiError(
          200,
          "invalid_response",
          "Backend returned invalid agent activity references or timing.",
        );
      }
      seen.add(key);
      previous = event.step;
    }
  }
  if (events.communication_events) {
    const openings = new Set(
      [...building.doors, ...building.exits].map((o) => o.id),
    );
    const seen = new Set<string>();
    let previousStep = firstStep;
    for (const event of events.communication_events) {
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
}

function checkSimulation(
  result: SimulationResult,
  building: BuildingScenario,
): SimulationResult {
  checkMetrics(result);
  let previousCaught = new Map<number, string>(),
    previousEscaped = 0;
  let previousEvents: PursuitEvent[] | undefined;
  let eventsRecorded: boolean | undefined;
  const inBounds = (p: { x: number; y: number }) =>
    p.x <= result.width && p.y <= result.height;
  if (building.pursuit && !result.frames.length)
    throw new ApiError(
      200,
      "invalid_response",
      "The backend returned no pursuit recording. Restart the updated Rust server.",
    );
  for (const frame of result.frames) {
    const p = frame.pursuit;
    if (!!p !== !!building.pursuit)
      throw new ApiError(
        200,
        "invalid_response",
        "The backend recording does not match the requested pursuit mode.",
      );
    if (!p) continue;
    const caught = new Map(
      p.caught.map((c) => [c.agent_id, JSON.stringify(c)]),
    );
    const seen = new Set<number>(),
      warned = new Set<number>();
    if (
      p.events &&
      (p.events.some((e, i) => {
        const identifiers =
          e.event_type === "sighting" ? [e.sender_id] : e.recipient_ids;
        const recipientsSeen = e.event_type === "sighting" ? seen : warned;
        let repeated = false;
        for (const id of identifiers) {
          repeated ||= recipientsSeen.has(id);
          recipientsSeen.add(id);
        }
        return (
          repeated ||
          e.step > frame.step ||
          e.sender_id >= result.total_population ||
          !inBounds(e.position) ||
          (i > 0 && p.events![i - 1]!.step > e.step) ||
          e.recipient_ids.includes(e.sender_id) ||
          e.recipient_ids.some((id) => id >= result.total_population)
        );
      }) ||
        (previousEvents ?? []).some(
          (e, i) => JSON.stringify(e) !== JSON.stringify(p.events![i]),
        ))
    )
      throw new ApiError(
        200,
        "invalid_response",
        "Invalid or changing pursuit events.",
      );
    if (
      eventsRecorded !== undefined &&
      eventsRecorded !== (p.events !== undefined)
    )
      throw new ApiError(
        200,
        "invalid_response",
        "Missing recorded pursuit events.",
      );
    previousEvents = p.events;
    eventsRecorded = p.events !== undefined;
    if (
      p.stalker.x > result.width ||
      p.stalker.y > result.height ||
      caught.size !== p.caught.length ||
      p.caught.some(
        (c) =>
          c.agent_id >= result.total_population ||
          c.step > frame.step ||
          (c.position && !inBounds(c.position)),
      ) ||
      [...previousCaught].some(([id, step]) => caught.get(id) !== step) ||
      p.escaped < previousEscaped ||
      p.escaped + caught.size + frame.agents.length !==
        result.total_population ||
      frame.agents.some(
        (a) => a.id >= result.total_population || caught.has(a.id),
      )
    )
      throw new ApiError(
        200,
        "invalid_response",
        "The backend returned invalid pursuit outcomes or survivor accounting.",
      );
    previousCaught = caught;
    previousEscaped = p.escaped;
  }
  const finalPursuit = result.frames.at(-1)?.pursuit;
  if (finalPursuit && finalPursuit.escaped !== result.evacuated)
    throw new ApiError(
      200,
      "invalid_response",
      "Pursuit escapes disagree with the recorded outcome.",
    );
  checkChat(
    result,
    building,
    new Set([
      ...(result.frames[0]?.agents.map((a) => a.id) ?? []),
      ...(result.analytics?.agents.map((a) => a.id) ?? []),
    ]),
    result.frames.at(-1)?.step ?? -1,
  );
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
        frame.disaster_state?.areas.some(
          (area) =>
            area.center.x > result.width ||
            area.center.y > result.height ||
            area.revision > frame.step,
        ) ||
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
      ...(s.approaching_agent_ids ?? []),
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
    computationId?: string,
    keepalive = false,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(computationId ? { "X-Computation-Id": computationId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        keepalive,
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

  async function runJob<T>(
    input: JobRequest,
    validate: ValidateFunction<T>,
    signal: AbortSignal | undefined,
    id: string,
    onStatus: (job: JobSnapshot) => void,
  ): Promise<T> {
    let job = await request(
      "/jobs",
      validateJob,
      { id, request: input },
      signal,
    );
    const cached = job.cached;
    for (;;) {
      signal?.throwIfAborted();
      onStatus({ ...job, cached });
      if (job.status === "completed")
        return request(
          `/jobs/${encodeURIComponent(job.id)}/result`,
          validate,
          undefined,
          signal,
        );
      if (job.status === "failed")
        throw new ApiError(
          422,
          "job_failed",
          job.error ?? "Computation failed.",
        );
      if (job.status === "cancelled")
        throw new DOMException("Computation cancelled", "AbortError");
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(done, 300);
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      job = await request(
        `/jobs/${encodeURIComponent(job.id)}`,
        validateJob,
        undefined,
        signal,
      );
    }
  }
  return {
    recordScenario: async (
      stress_job_id: string,
      scenario_id: string,
      signal: AbortSignal,
      id: string,
      onStatus: (job: JobSnapshot) => void,
    ) => {
      const replay = await runJob(
        { kind: "replay", stress_job_id, scenario_id },
        validateReplay,
        signal,
        id,
        onStatus,
      );
      checkSimulation(replay.result, replay.building);
      return replay;
    },
    listJobs: (signal?: AbortSignal) =>
      request("/jobs", validateJobs, undefined, signal),
    jobRequest: (id: string, signal?: AbortSignal) =>
      request(
        `/jobs/${encodeURIComponent(id)}/request`,
        validateJobRequest,
        undefined,
        signal,
      ),
    jobResult: async (id: string, input: JobRequest, signal?: AbortSignal) => {
      const path = `/jobs/${encodeURIComponent(id)}/result`;
      if (input.kind === "replay") {
        const replay = await request(path, validateReplay, undefined, signal);
        checkSimulation(replay.result, replay.building);
        return replay;
      }
      if (input.kind === "simulate")
        return checkSimulation(
          await request(path, validateSimulation, undefined, signal),
          input.building,
        );
      if (input.kind === "stress") {
        const result = await request(path, validateStress, undefined, signal);
        checkMetrics(result.baseline);
        result.scenarios.forEach((s) => checkMetrics(s.metrics));
        return result;
      }
      const result = await request(
        path,
        validateOptimization,
        undefined,
        signal,
      );
      checkMetrics(result.baseline);
      result.candidates.forEach((s) => checkMetrics(s.metrics));
      return result;
    },
    cancelComputation: (id: string) =>
      request(
        `/computations/${encodeURIComponent(id)}/cancel`,
        validateCancellation,
        {},
        undefined,
        undefined,
        true,
      ),
    health: (signal?: AbortSignal) =>
      request("/health", validateHealth, undefined, signal),
    simulate: async (
      building: BuildingScenario,
      signal?: AbortSignal,
      computationId?: string,
      onStatus?: (job: JobSnapshot) => void,
    ): Promise<SimulationResult> => {
      const result = onStatus
        ? await runJob(
            { kind: "simulate", building },
            validateSimulation,
            signal,
            computationId ?? crypto.randomUUID(),
            onStatus,
          )
        : await request(
            "/simulate",
            validateSimulation,
            building,
            signal,
            computationId,
          );
      return checkSimulation(result, building);
    },
    setLiveSpeed: (
      runId: string,
      speed: LiveSpeedControl["speed"],
      signal?: AbortSignal,
    ) =>
      request(
        `/simulate/live/${encodeURIComponent(runId)}/speed`,
        validateLiveSpeed,
        { speed },
        signal,
      ),
    simulateLive: async (
      building: BuildingScenario,
      onFrame: (frame: AnimationFrame) => void,
      signal?: AbortSignal,
      onChat?: (chat: LiveChatBatch) => void,
      computationId?: string,
    ): Promise<SimulationResult> => {
      let response: Response;
      try {
        const query = computationId
          ? `?${new URLSearchParams({ run_id: computationId })}`
          : "";
        response = await fetch(
          `${baseUrl.replace(/\/$/, "")}/simulate/live${query}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/x-ndjson",
              ...(computationId ? { "X-Computation-Id": computationId } : {}),
            },
            body: JSON.stringify(building),
            signal,
          },
        );
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
      let initialIds = new Set<number>();
      let lastChatStep = 0;
      const population = totalPopulation(building);
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
        if (event.type === "chat") {
          if (lastStep < 0)
            throw new ApiError(
              200,
              "invalid_response",
              "Live chat arrived before the simulation started.",
            );
          checkChat(event, building, initialIds, lastStep, lastChatStep);
          lastChatStep = Math.max(
            lastChatStep,
            event.communication_events.at(-1)?.step ?? 0,
            event.agent_events.at(-1)?.step ?? 0,
          );
          onChat?.(event);
          return null;
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
        if (lastStep < 0) initialIds = ids;
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
      signal?: AbortSignal,
      computationId?: string,
      onStatus?: (job: JobSnapshot) => void,
    ): Promise<StressTestResult> => {
      const result = onStatus
        ? await runJob(
            { kind: "stress", request: payload },
            validateStress,
            signal,
            computationId ?? crypto.randomUUID(),
            onStatus,
          )
        : await request(
            "/stress-test",
            validateStress,
            payload,
            signal,
            computationId,
          );
      checkMetrics(result.baseline);
      result.scenarios.forEach((scenario) => checkMetrics(scenario.metrics));
      return result;
    },
    optimize: async (
      payload: OptimizeRequest,
      signal?: AbortSignal,
      computationId?: string,
      onStatus?: (job: JobSnapshot) => void,
    ): Promise<OptimizationResult> => {
      const result = onStatus
        ? await runJob(
            { kind: "optimize", request: payload },
            validateOptimization,
            signal,
            computationId ?? crypto.randomUUID(),
            onStatus,
          )
        : await request(
            "/optimize",
            validateOptimization,
            payload,
            signal,
            computationId,
          );
      checkMetrics(result.baseline);
      result.candidates.forEach((candidate) => checkMetrics(candidate.metrics));
      return result;
    },
  };
}

export const api = createApiClient();
