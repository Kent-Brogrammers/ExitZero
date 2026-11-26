import type {
  AgentModifier,
  AgentModifierParameters,
  BuildingScenario,
} from "../types/simulation";

export const modifierFields = {
  speed_multiplier: ["Walking speed", 0.1, 2],
  acceleration_multiplier: ["Acceleration", 0.1, 2],
  reaction_delay_seconds: ["Reaction delay (s)", 0, 30],
  hazard_cost_multiplier: ["Known hazard avoidance", 0.25, 4],
  crowd_cost_multiplier: ["Crowd avoidance", 0, 4],
  reassessment_interval_multiplier: ["Reassessment interval", 0.25, 4],
  route_switch_threshold_multiplier: ["Route switch threshold", 0.25, 4],
  avoidance_priority_multiplier: ["Avoidance priority", 0.25, 4],
} as const;
export const modifierPresets: AgentModifier[] = [
  { id: "curious", name: "Curious", requires_emergency_discovery: true },
  {
    id: "older",
    name: "Older",
    speed_multiplier: 0.7,
    acceleration_multiplier: 0.65,
  },
  {
    id: "scared",
    name: "Scared",
    speed_multiplier: 0.25,
    acceleration_multiplier: 0.4,
    reaction_delay_seconds: 4,
    hazard_cost_multiplier: 2,
    route_switch_threshold_multiplier: 0.65,
  },
  {
    id: "aggressive",
    name: "Aggressive",
    speed_multiplier: 1.15,
    crowd_cost_multiplier: 0.25,
    reassessment_interval_multiplier: 0.6,
    avoidance_priority_multiplier: 3,
  },
  {
    id: "calm",
    name: "Calm",
    hazard_cost_multiplier: 1.4,
    crowd_cost_multiplier: 1.5,
    route_switch_threshold_multiplier: 1.25,
  },
  {
    id: "limited_mobility",
    name: "Limited mobility",
    speed_multiplier: 0.45,
    acceleration_multiplier: 0.5,
  },
];

/** Store the full experiment before running; the Rust spawner makes the actual choices. */
export function withAutomaticModifiers(
  building: BuildingScenario,
): BuildingScenario {
  if (building.pursuit) return building;
  const definitions = [...(building.agent_modifiers ?? [])];
  for (const preset of modifierPresets) {
    if (!definitions.some((m) => m.id === preset.id) && definitions.length < 64)
      definitions.push({ ...preset });
  }
  if (building.spawn_modifier_ids !== undefined)
    return definitions.length === (building.agent_modifiers?.length ?? 0)
      ? building
      : { ...building, agent_modifiers: definitions };
  return automaticModifiers(
    building,
    definitions,
    definitions.map((m) => m.id),
  );
}

export function automaticModifiers(
  building: BuildingScenario,
  definitions: AgentModifier[],
  allowed: string[],
): BuildingScenario {
  return {
    ...building,
    agent_modifiers: definitions,
    spawn_modifier_ids: allowed,
    personality_fraction: building.personality_fraction ?? 0.3,
    agent_speed_variation: building.agent_speed_variation ?? 0.05,
    placed_occupants: building.placed_occupants?.map((p) => ({
      ...p,
      modifier_ids: undefined,
    })),
    spawn_zones: building.spawn_zones.map((z) => ({
      ...z,
      modifier_groups: undefined,
    })),
  };
}

export function resolvedModifiers(
  definitions: readonly AgentModifier[],
  ids: readonly string[],
) {
  const resolved = Object.fromEntries(
    Object.keys(modifierFields).map((field) => [
      field,
      field === "reaction_delay_seconds" ? 0 : 1,
    ]),
  ) as unknown as AgentModifierParameters;
  for (const id of [...ids].sort()) {
    const modifier = definitions.find((m) => m.id === id);
    if (!modifier) continue;
    for (const field of Object.keys(
      modifierFields,
    ) as (keyof AgentModifierParameters)[]) {
      const value =
        modifier[field] ?? (field === "reaction_delay_seconds" ? 0 : 1);
      if (field === "reaction_delay_seconds") resolved[field] += value;
      else resolved[field] *= value;
    }
  }
  for (const field of Object.keys(
    modifierFields,
  ) as (keyof AgentModifierParameters)[]) {
    const [, min, max] = modifierFields[field];
    resolved[field] = Math.min(max, Math.max(min, resolved[field]));
  }
  return resolved;
}

export function modifierAssignmentError(
  building: BuildingScenario,
): string | null {
  const definitions = building.agent_modifiers ?? [];
  const ids = new Set(definitions.map((m) => m.id));
  if (ids.size !== definitions.length)
    return "Agent modifier IDs must be unique.";
  const check = (references: string[]) =>
    references.length === new Set(references).size &&
    references.every((id) => ids.has(id));
  if (building.spawn_modifier_ids !== undefined) {
    if (!check(building.spawn_modifier_ids))
      return "Allowed spawn modifiers must reference known, distinct modifiers.";
    if (
      building.placed_occupants?.some((p) => p.modifier_ids?.length) ||
      building.spawn_zones.some((z) => z.modifier_groups !== undefined)
    )
      return "Automatic spawn modifiers cannot be combined with explicit occupant or zone assignments.";
  }
  for (const person of building.placed_occupants ?? []) {
    if (!check(person.modifier_ids ?? []))
      return "Occupants must reference known, distinct agent modifiers.";
  }
  for (const zone of building.spawn_zones) {
    if (
      zone.modifier_groups &&
      (zone.modifier_groups.reduce((sum, g) => sum + g.count, 0) !==
        zone.count ||
        zone.modifier_groups.some((g) => !check(g.modifier_ids)))
    ) {
      return "Modifier group counts must equal the spawn zone population and reference known, distinct modifiers.";
    }
  }
  if (building.pursuit) {
    if ((building.agent_speed_variation ?? 0) !== 0)
      return "Pursuit does not support agent speed variation.";
    const assignments = [
      building.spawn_modifier_ids ?? [],
      ...(building.placed_occupants ?? []).map((p) => p.modifier_ids ?? []),
      ...building.spawn_zones.flatMap(
        (z) => z.modifier_groups?.map((g) => g.modifier_ids) ?? [],
      ),
    ];
    if (
      assignments.some((assignment) =>
        assignment.some((id) => {
          const m = definitions.find((definition) => definition.id === id)!;
          return (
            m.requires_emergency_discovery ||
            Object.keys(modifierFields).some((key) => {
              const field = key as keyof AgentModifierParameters;
              return (
                (m[field] ?? (field === "reaction_delay_seconds" ? 0 : 1)) !==
                (field === "reaction_delay_seconds" ? 0 : 1)
              );
            })
          );
        }),
      )
    )
      return "Pursuit does not support active nonneutral agent modifiers.";
  }
  return null;
}
