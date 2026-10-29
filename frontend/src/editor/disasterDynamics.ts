import type { DisasterDynamics, DisasterKind } from "../types/simulation";

export function defaultDynamics(
  kind: DisasterKind,
  radius: number,
): DisasterDynamics {
  return {
    enabled: true,
    growth_rate: kind === "fire" ? 0.036 : kind === "gas_leak" ? 0.12 : 0.06,
    spread_interval_seconds: kind === "fire" ? 3 : 2.5,
    max_patches: kind === "fire" ? 64 : kind === "gas_leak" ? 1 : 32,
    max_radius:
      kind === "fire"
        ? Math.max(radius, 1.2)
        : Math.max(0.01, Math.min(1000, radius * 2)),
    speed: 1.2,
    turn_rate_degrees: 50,
    wander_interval_seconds: 3,
    shelter_clearance: 0.5,
  };
}
