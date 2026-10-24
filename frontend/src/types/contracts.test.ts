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

describe("shared continuous geometry schemas", () => {
  it("validates the shared 30 × 20 metre example", () => {
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
  it("accepts decimal positions and world-space traffic samples", () => {
    expect(
      validateSimulation(mock),
      ajv.errorsText(validateSimulation.errors),
    ).toBe(true);
    expect(mock.frames[0]!.agents[0]!.x % 1).not.toBe(0);
  });
  it("rejects legacy cells, non-finite coordinates, unsafe seeds, and missing references", () => {
    for (const invalid of [
      { ...building, blocked_cells: [] },
      { ...building, width: 0 },
      {
        ...building,
        walls: [
          {
            id: "bad",
            start: { x: NaN, y: 1 },
            end: { x: 2, y: 2 },
            thickness: 0.2,
          },
        ],
      },
      { ...building, seed: Number.MAX_SAFE_INTEGER + 1 },
      { ...building, exits: [{ id: "a", x: 1, y: 1 }] },
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
