// Shared JSON names stay snake_case. Review contract changes with the team.
export interface Cell {
  x: number;
  y: number;
}

export interface Exit extends Cell {
  id: string;
}

export interface SpawnZone extends Cell {
  width: number;
  height: number;
  count: number;
}

export interface BuildingScenario {
  width: number;
  height: number;
  walls: Cell[];
  doors: Cell[];
  exits: Exit[];
  spawn_zones: SpawnZone[];
  blocked_exit_ids: string[];
  blocked_cells: Cell[];
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

export interface AgentPosition extends Cell {
  id: number;
}

export interface AnimationFrame {
  step: number;
  agents: AgentPosition[];
}

export interface SimulationResult extends SimulationMetrics {
  frames: AnimationFrame[];
  /** Accumulated traffic at index y * width + x; not instantaneous density. */
  cell_visits: number[];
  width: number;
  height: number;
}

export interface StressTestConfig {
  max_scenarios: number;
  block_each_exit: boolean;
  blocked_cell_candidates: Cell[];
}

export interface StressTestRequest {
  building: BuildingScenario;
  config: StressTestConfig;
}

export interface ScenarioModifications {
  /** Additional blockers applied to the baseline. */
  blocked_exit_ids: string[];
  blocked_cells: Cell[];
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
