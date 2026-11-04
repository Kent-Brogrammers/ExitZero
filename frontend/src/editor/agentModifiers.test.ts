import Ajv from "ajv";
import { expect, it } from "vitest";
import schema from "../../../shared/schemas/contracts.schema.json";
import example from "../../../shared/examples/agent-modifiers.json";
import { buildingError } from "./geometry";
import {
  modifierAssignmentError,
  resolvedModifiers,
  withAutomaticModifiers,
  modifierPresets,
} from "./agentModifiers";
import type { BuildingScenario } from "../types/simulation";

it("defaults ordinary layouts to all saved presets and replaces manual population setup", () => {
  const legacy: BuildingScenario = structuredClone(example);
  const configured = withAutomaticModifiers(legacy);
  expect(configured.spawn_modifier_ids).toEqual(
    configured.agent_modifiers!.map((m) => m.id),
  );
  expect(
    modifierPresets.every((preset) =>
      configured.spawn_modifier_ids!.includes(preset.id),
    ),
  ).toBe(true);
  expect(
    configured.spawn_zones.every((z) => z.modifier_groups === undefined),
  ).toBe(true);
  expect(legacy.spawn_zones[0]!.modifier_groups).toBeDefined();
  expect(buildingError(configured)).toBeNull();
  expect(withAutomaticModifiers(configured)).toBe(configured);
  configured.spawn_modifier_ids = [];
  expect(withAutomaticModifiers(configured).spawn_modifier_ids).toEqual([]);
});

it("loads and preserves the shared modifier example and counted groups", () => {
  const building: BuildingScenario = structuredClone(example);
  const validate = new Ajv({ allErrors: true }).compile(schema);
  expect(validate(building), JSON.stringify(validate.errors)).toBe(true);
  expect(buildingError(building)).toBeNull();
  expect(buildingError(JSON.parse(JSON.stringify(building)))).toBeNull();
});

it("composes in stable order and caps only the final effective parameters", () => {
  const definitions = [
    { id: "a", name: "A", speed_multiplier: 2, reaction_delay_seconds: 20 },
    { id: "b", name: "B", speed_multiplier: 2, reaction_delay_seconds: 20 },
    { id: "c", name: "C", speed_multiplier: 0.5 },
  ];
  const resolved = resolvedModifiers(definitions, ["c", "a", "b"]);
  expect(resolved.speed_multiplier).toBe(2);
  expect(resolved.reaction_delay_seconds).toBe(30);
  expect(resolved).toEqual(
    resolvedModifiers([...definitions].reverse(), ["b", "a", "c"]),
  );
});

it("rejects duplicate/unknown references, inconsistent counts, and unsupported pursuit assignments", () => {
  const b: BuildingScenario = structuredClone(example);
  b.spawn_zones[0]!.modifier_groups![0]!.modifier_ids = ["older", "older"];
  expect(modifierAssignmentError(b)).toMatch(/distinct/);
  b.spawn_zones[0]!.modifier_groups![0]!.modifier_ids = ["unknown"];
  expect(modifierAssignmentError(b)).toMatch(/known/);
  b.spawn_zones[0]!.modifier_groups![0]!.modifier_ids = [];
  b.spawn_zones[0]!.modifier_groups![0]!.count--;
  expect(modifierAssignmentError(b)).toMatch(/counts/);
  b.spawn_zones[0]!.modifier_groups![0]!.count++;
  b.pursuit = {} as NonNullable<BuildingScenario["pursuit"]>;
  expect(modifierAssignmentError(b)).toMatch(/Pursuit/);
});

it("rejects malformed numeric effects, duplicate definitions, and null optionals", () => {
  for (const patch of [
    { agent_speed_variation: 0.21 },
    { agent_speed_variation: null },
    { agent_modifiers: [{ id: "bad", name: "Bad", speed_multiplier: 0 }] },
    {
      agent_modifiers: [
        { id: "bad", name: "Bad", hazard_cost_multiplier: NaN },
      ],
    },
    {
      agent_modifiers: [
        { id: "older", name: "One" },
        { id: "older", name: "Two" },
      ],
    },
  ])
    expect(buildingError({ ...example, ...patch })).not.toBeNull();
});
