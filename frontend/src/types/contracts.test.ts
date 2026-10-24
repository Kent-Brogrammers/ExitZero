import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import contracts from "../../../shared/schemas/contracts.schema.json";
import building from "../../../shared/examples/building.json";
import mock from "../../../shared/examples/simulation.mock.json";
import type { BuildingScenario, SimulationResult } from "./simulation";

const ajv = new Ajv({ allErrors: true });
ajv.addSchema(contracts);
const validateBuilding = ajv.getSchema<BuildingScenario>(
  `${contracts.$id}#/$defs/BuildingScenario`,
)!;
const validateSimulation = ajv.getSchema<SimulationResult>(
  `${contracts.$id}#/$defs/SimulationResult`,
)!;

describe("shared JSON schemas", () => {
  it("validates the 30 × 20 example used by both Rust and TypeScript", () => {
    const typedBuilding: BuildingScenario = building;
    expect(
      validateBuilding(typedBuilding),
      ajv.errorsText(validateBuilding.errors),
    ).toBe(true);
    expect([
      typedBuilding.width,
      typedBuilding.height,
      typedBuilding.exits.length,
    ]).toEqual([30, 20, 2]);
  });

  it("validates the explicitly synthetic animation fixture", () => {
    expect(
      validateSimulation(mock),
      ajv.errorsText(validateSimulation.errors),
    ).toBe(true);
    expect(mock.cell_visits.length).toBe(mock.width * mock.height);
  });

  it("rejects wrong casing, fractional coordinates, unsafe seeds, and empty zones", () => {
    for (const invalid of [
      { ...building, spawnZones: [] },
      { ...building, width: 0 },
      { ...building, walls: [{ x: 0.5, y: 1 }] },
      { ...building, seed: Number.MAX_SAFE_INTEGER + 1 },
      { ...building, spawn_zones: [] },
      { ...building, max_steps: 0 },
    ])
      expect(validateBuilding(invalid)).toBe(false);
  });

  it("requires remaining occupants and null clearance on unfinished results", () => {
    expect(validateSimulation({ ...mock, clearance_steps: 1 })).toBe(false);
    expect(validateSimulation({ ...mock, remaining: 0 })).toBe(false);
    expect(
      validateSimulation({
        ...mock,
        status: "completed",
        remaining: 0,
        trapped: 0,
        evacuated: 2,
        clearance_steps: 1,
      }),
    ).toBe(true);
  });
});
