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
/** Solid glazing unless explicitly configured and serviced by the Rust engine. */
export interface WindowOpening extends Opening {
  emergency_escape?: {
    enabled: boolean;
    preparation: "open" | "break";
    clear_width_metres: number;
    clear_height_metres: number;
    preparation_seconds: number;
    traversal_seconds: number;
    exterior_side: -1 | 1;
    exterior_available: boolean;
  };
}
export interface WindowEscapeContext {
  floor_elevation_metres: number;
  all_agents_can_traverse: boolean;
  required_clear_height_metres: number;
}
export interface WindowFrameState {
  window_id: string;
  state: "intact" | "opening" | "breaking" | "open" | "broken";
  preparation_ready_step: number | null;
  queue_agent_ids: number[];
  traversing_agent_id: number | null;
  traversal_earliest_finish_step: number | null;
}
export interface EscapeRoute {
  kind: "normal_exit" | "emergency_window";
  opening_id: string;
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
/** Walkable, nonblocking architectural annotation; no inter-floor transport. */
export interface StairArea extends Obstruction {
  orientation_degrees?: 0 | 90 | 180 | 270;
}
export type DisasterKind = "fire" | "gas_leak" | "tornado";
export interface Disaster {
  kind: DisasterKind;
  center: Point;
  radius: number;
  dynamics?: DisasterDynamics;
}
export interface DisasterDynamics {
  enabled: boolean;
  growth_rate: number;
  spread_interval_seconds: number;
  max_patches: number;
  max_radius: number;
  speed: number;
  turn_rate_degrees: number;
  wander_interval_seconds: number;
  shelter_clearance: number;
}
export interface HazardArea {
  id: number;
  revision: number;
  center: Point;
  radius: number;
}
export interface DisasterState {
  kind: DisasterKind;
  areas: HazardArea[];
}
export interface ShelterArrival {
  id: string;
  step: number;
  seconds: number;
}

export interface BuildingScenario {
  width: number;
  height: number;
  walls: Wall[];
  doors: Opening[];
  exits: Opening[];
  windows?: WindowOpening[];
  window_escape_context?: WindowEscapeContext;
  spawn_zones: SpawnZone[];
  blocked_exit_ids: string[];
  /** Omitted settings use 8 m sight and 3 m communication ranges. Zero disables a range. */
  awareness?: AgentAwareness;
  opening_events?: OpeningStateChange[];
  obstructions: Obstruction[];
  stair_areas?: StairArea[];
  tornado_zones?: Obstruction[];
  disaster?: Disaster;
  agent_radius: number;
  time_step_seconds: number;
  seed: number;
  max_steps: number;
}

export interface AgentAwareness {
  sight_range_metres: number;
  communication_range_metres: number;
}

export interface OpeningStateChange {
  step: number;
  opening_id: string;
  blocked: boolean;
}

export type SimulationStatus = "completed" | "incomplete" | "timeout";

export interface SimulationMetrics {
  status: SimulationStatus;
  total_population: number;
  evacuated: number;
  sheltered?: number;
  /** A subset of remaining, not an additional population category. */
  trapped: number;
  remaining: number;
  clearance_steps: number | null;
  evacuated_by_route?: { normal_exit: number; emergency_window: number };
}

export interface AgentPosition extends Point {
  id: number;
  injury?: number;
}

export interface AnimationFrame {
  step: number;
  agents: AgentPosition[];
  /** Physical state at this time; absent in older recordings. */
  blocked_opening_ids?: string[];
<<<<<<< HEAD
  window_states?: WindowFrameState[];
=======
  sheltered?: number;
  disaster_state?: DisasterState;
>>>>>>> connor/catastrophes
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
  escape_route?: EscapeRoute | null;
  /** Latest route search using personal opening knowledge; false does not prove entrapment. */
  route_found: boolean;
  shelter?: ShelterArrival;
  injury?: number;
  exposure_seconds?: number;
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

/** Newline-delimited events from POST /api/simulate/live. */
export type SimulationStreamEvent =
  | { type: "frame"; frame: AnimationFrame }
  | { type: "complete"; result: SimulationResult }
  | { type: "error"; error: { code: string; message: string } };

/** A running simulation has no outcome or known duration yet. */
export interface LiveSimulation {
  frame: AnimationFrame | null;
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
