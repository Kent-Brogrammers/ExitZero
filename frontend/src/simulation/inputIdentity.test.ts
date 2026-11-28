import { expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import {
  canonicalSimulationInput,
  simulationInputFingerprint,
} from "./inputIdentity";

const fixture = (): BuildingScenario => structuredClone(example);

it("matches equivalent JSON object-key orders without mutating either input", async () => {
  const original = fixture();
  const reordered = JSON.parse(
    JSON.stringify(original, function (_key, value) {
      if (value && typeof value === "object" && !Array.isArray(value))
        return Object.fromEntries(Object.entries(value).reverse());
      return value;
    }),
  );
  const before = JSON.stringify(original),
    other = JSON.stringify(reordered);
  expect(before).not.toBe(other);
  expect(canonicalSimulationInput(original)).toBe(
    canonicalSimulationInput(reordered),
  );
  expect(await simulationInputFingerprint(original)).toBe(
    await simulationInputFingerprint(reordered),
  );
  expect(JSON.stringify(original)).toBe(before);
  expect(JSON.stringify(reordered)).toBe(other);
});

it("ignores display renaming while retaining the complete named request", async () => {
  const original = {
    ...fixture(),
    agent_modifiers: [{ id: "slow", name: "Slow", speed_multiplier: 0.8 }],
  };
  const renamed = structuredClone(original);
  renamed.walls[0]!.name = "North hallway";
  renamed.doors[0]!.name = "Meeting room";
  renamed.exits[0]!.name = "Main exit";
  renamed.spawn_zones[0]!.name = "Reception";
  renamed.agent_modifiers[0]!.name = "Gentle walker";
  expect(await simulationInputFingerprint(renamed)).toBe(
    await simulationInputFingerprint(original),
  );
  expect(renamed.agent_modifiers[0]!.name).toBe("Gentle walker");
  expect(renamed.walls[0]!.name).toBe("North hallway");
});

const changes: [string, (building: BuildingScenario) => void][] = [
  [
    "same-size wall geometry",
    (b) => {
      b.walls[0]!.thickness += 0.02;
    },
  ],
  [
    "door geometry",
    (b) => {
      b.doors[0]!.offset += 0.2;
    },
  ],
  [
    "stable opening IDs",
    (b) => {
      b.doors[0]!.id = "renamed-stable-id";
    },
  ],
  [
    "random seed",
    (b) => {
      b.seed++;
    },
  ],
  [
    "time step",
    (b) => {
      b.time_step_seconds = 0.2;
    },
  ],
  [
    "maximum steps",
    (b) => {
      b.max_steps++;
    },
  ],
  [
    "population",
    (b) => {
      b.spawn_zones[0]!.count--;
    },
  ],
  [
    "blocked exits",
    (b) => {
      b.blocked_exit_ids = ["west"];
    },
  ],
  [
    "opening schedule",
    (b) => {
      b.opening_events = [{ step: 1, opening_id: "door_north", blocked: true }];
    },
  ],
  [
    "communication",
    (b) => {
      b.awareness = { sight_range_metres: 1, communication_range_metres: 0 };
    },
  ],
  [
    "hazards",
    (b) => {
      b.disaster = { kind: "fire", center: { x: 20, y: 8 }, radius: 1 };
    },
  ],
  [
    "exact occupant positions",
    (b) => {
      b.placed_occupants = [{ id: "person", x: 12, y: 5 }];
    },
  ],
  [
    "speed variation",
    (b) => {
      b.agent_speed_variation = 0.05;
    },
  ],
  [
    "modifier behavior",
    (b) => {
      b.agent_modifiers = [{ id: "slow", name: "Slow", speed_multiplier: 0.8 }];
    },
  ],
];
it.each(changes)(
  "distinguishes %s without relying on dimensions or population alone",
  async (_label, edit) => {
    const original = fixture(),
      changed = fixture();
    edit(changed);
    expect(await simulationInputFingerprint(changed)).not.toBe(
      await simulationInputFingerprint(original),
    );
  },
);

it("preserves occupant and spawn ordering because it controls stable recorded IDs", async () => {
  const original = fixture();
  original.placed_occupants = [
    { id: "first", x: 12, y: 5 },
    { id: "second", x: 12, y: 7 },
  ];
  const swappedPeople = structuredClone(original);
  swappedPeople.placed_occupants!.reverse();
  const swappedZones = structuredClone(original);
  swappedZones.spawn_zones.reverse();
  const fingerprint = await simulationInputFingerprint(original);
  expect(await simulationInputFingerprint(swappedPeople)).not.toBe(fingerprint);
  expect(await simulationInputFingerprint(swappedZones)).not.toBe(fingerprint);
});

it("does not guess equivalence between missing settings and an engine's current defaults", async () => {
  const missing = fixture(),
    explicit = fixture();
  explicit.awareness = { sight_range_metres: 1, communication_range_metres: 3 };
  expect(await simulationInputFingerprint(missing)).not.toBe(
    await simulationInputFingerprint(explicit),
  );
});

it("captures input bytes before asynchronous hashing and uses a versioned identity", async () => {
  const source = fixture(),
    original = fixture();
  const pending = simulationInputFingerprint(source);
  source.seed++;
  const fingerprint = await pending;
  expect(fingerprint).toMatch(/^exitzero-input-v1:sha256:[a-f0-9]{64}$/);
  expect(fingerprint).toBe(await simulationInputFingerprint(original));
  expect(fingerprint).not.toBe(await simulationInputFingerprint(source));
});

it("rejects invalid input rather than fingerprinting a silently repaired layout", async () => {
  const bad = fixture();
  bad.walls[0]!.thickness = -1;
  await expect(simulationInputFingerprint(bad)).rejects.toThrow(
    /Cannot identify invalid simulation input/,
  );
});
