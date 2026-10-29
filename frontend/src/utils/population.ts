import type { BuildingScenario } from "../types/simulation";

export function totalPopulation(
  building: Pick<BuildingScenario, "spawn_zones" | "placed_occupants">,
) {
  return (
    (building.placed_occupants?.length ?? 0) +
    building.spawn_zones.reduce((sum, zone) => sum + zone.count, 0)
  );
}
