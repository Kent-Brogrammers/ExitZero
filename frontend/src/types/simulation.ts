// Shared JSON names stay snake_case. Review contract changes with the team.
/** Continuous world coordinates in metres. */
export interface Point {
  x: number;
  y: number;
}
export interface Wall {
  id: string;
  /** Display metadata only; references always use id. */
  name?: string;
  start: Point;
  end: Point;
  thickness: number;
}
export interface Opening {
  id: string;
  /** Display metadata only; references always use id. */
  name?: string;
  wall_id: string;
  offset: number;
  width: number;
}
export interface Obstruction {
  id: string;
  /** Display metadata only; references always use id. */
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SpawnZone extends Obstruction {
  count: number;
}
export interface BuildingScenario {
  width: number;
  height: number;
  walls: Wall[];
  doors: Opening[];
  exits: Opening[];
  spawn_zones: SpawnZone[];
  blocked_exit_ids: string[];
  obstructions: Obstruction[];
  agent_radius: number;
  time_step_seconds: number;
  seed: number;
  max_steps: number;
}

export type SimulationStatus = "completed" | "incomplete" | "timeout";

export interface SimulationMetrics {
  status: SimulationStatus;
  total_population: number;
  evacuated: number;
  /** A subset of remaining, not an additional population category. */
  trapped: number;
  remaining: number;
  clearance_steps: number | null;
}

export interface AgentPosition extends Point {
  id: number;
}

export interface AnimationFrame {
  step: number;
  agents: AgentPosition[];
}

export interface AgentStatistics {
  /** Same ID as animation frames. */
  id: number;
  /** Actual accepted travel, including detours, in metres. */
  distance_metres: number;
  /** Collision-rejected ticks; occupants without routes do not accumulate waits. */
  waiting_steps: number;
  waiting_seconds: number;
  /** Time until evacuation, or until the run ended for remaining occupants. */
  elapsed_seconds: number;
  evacuation_step: number | null;
  evacuation_seconds: number | null;
  /** Successful exit; null if this occupant did not evacuate. */
  exit_id: string | null;
  /** Graph search found a route; false does not prove physical entrapment. */
  route_found: boolean;
}

export interface SimulationAnalytics {
  agents: AgentStatistics[];
  simulated_seconds: number;
  /** Evacuated occupants only; null when none evacuated. */
  median_evacuation_seconds: number | null;
  total_distance_metres: number;
  total_waiting_seconds: number;
}

export interface SimulationResult extends SimulationMetrics {
  /** Absent in older saved results and synthetic fixtures. */
  analytics?: SimulationAnalytics;
  frames: AnimationFrame[];
  /** Weighted world positions representing accumulated traffic, not density. */
  traffic_samples: TrafficSample[];
  time_step_seconds: number;
  width: number;
  height: number;
}

export interface StressTestConfig {
  max_scenarios: number;
  block_each_exit: boolean;
  obstruction_candidates: Obstruction[];
}

export interface StressTestRequest {
  building: BuildingScenario;
  config: StressTestConfig;
}

export interface ScenarioModifications {
  /** Additional blockers applied to the baseline. */
  blocked_exit_ids: string[];
  added_obstructions: Obstruction[];
}

export interface StressScenarioResult {
  scenario_id: string;
  description: string;
  modifications: ScenarioModifications;
  metrics: SimulationMetrics;
  /** One-based, most severe first. */
  rank: number;
  severity: "low" | "moderate" | "high" | "critical";
}

export interface StressTestResult {
  baseline: SimulationMetrics;
  scenarios: StressScenarioResult[];
}

export interface OptimizeRequest {
  building: BuildingScenario;
  max_candidates: number;
}

export interface OptimizationCandidate {
  building: BuildingScenario;
  metrics: SimulationMetrics;
  rank: number;
}

export interface OptimizationResult {
  baseline: SimulationMetrics;
  candidates: OptimizationCandidate[];
}

export interface HealthResponse {
  status: "ok";
  service: "exitzero";
}

export interface ApiErrorResponse {
  error: { code: string; message: string };
}

export interface TrafficSample extends Point {
  visits: number;
}
