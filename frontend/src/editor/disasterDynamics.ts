import type { DisasterDynamics, DisasterKind } from "../types/simulation";

export function defaultDynamics(
  kind: DisasterKind,
  radius: number,
): DisasterDynamics {
  return {
    enabled: true,
    growth_rate: kind === "gas_leak" ? 0.12 : 0.06,
    spread_interval_seconds: 2.5,
    max_patches: kind === "gas_leak" ? 1 : 32,
    max_radius: Math.max(0.01, Math.min(1000, radius * 2)),
    speed: 1.2,
    turn_rate_degrees: 50,
    wander_interval_seconds: 3,
    shelter_clearance: 0.5,
  };
}
