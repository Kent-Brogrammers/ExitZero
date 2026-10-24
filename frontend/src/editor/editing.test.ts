import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import schema from "../../../shared/schemas/contracts.schema.json";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import { buildingError, removeElement, translateElement } from "./geometry";

const validateSchema = new Ajv({ allErrors: true }).compile<BuildingScenario>(
  schema,
);
const fixture = (): BuildingScenario => structuredClone(example);

describe("continuous building edit compatibility", () => {
  it("round-trips edited geometry through the established JSON contract", () => {
    const original = fixture();
    let building = translateElement(
      original,
      { kind: "walls", id: "angled" },
      { x: 0.375, y: -0.125 },
    );
    building = translateElement(
      building,
      { kind: "doors", id: "door_north" },
      { x: 0, y: 0.25 },
    );
    building.obstructions.push({
      id: "test-obstruction",
      x: 16.25,
      y: 4.5,
      width: 1.25,
      height: 2.5,
    });
    const json: unknown = JSON.parse(JSON.stringify(building));
    expect(validateSchema(json), JSON.stringify(validateSchema.errors)).toBe(
      true,
    );
    expect(buildingError(json)).toBeNull();
    expect(json).toEqual(building);
    expect(original).toEqual(example);
    expect(building.spawn_zones).toEqual(example.spawn_zones);
    expect([
      building.seed,
      building.max_steps,
      building.agent_radius,
      building.time_step_seconds,
    ]).toEqual([42, 1000, 0.25, 0.1]);
  });

  it("accepts decimal dimensions and keeps wall-attached exits when the workspace grows", () => {
    const original = fixture();
    const resized = { ...original, width: 40.25, height: 25.5 };
    expect(buildingError(resized)).toBeNull();
    expect(resized.exits).toEqual(original.exits);
    expect(original.width).toBe(30);
  });

  it.each([0, -1, 1001, NaN, Infinity])(
    "rejects invalid workspace width %s",
    (width) => {
      expect(buildingError({ ...fixture(), width })).not.toBeNull();
    },
  );

  it.each([
    [27, 20],
    [30, 17],
    [9, 8],
  ])(
    "rejects resizing that crops existing geometry (%s × %s)",
    (width, height) => {
      expect(buildingError({ ...fixture(), width, height })).not.toBeNull();
    },
  );

  it.each(["walls", "doors", "exits", "spawn_zones", "obstructions"] as const)(
    "removes a %s element without mutating the original",
    (kind) => {
      const original = fixture();
      original.obstructions.push({
        id: "obstacle",
        x: 16,
        y: 4,
        width: 1,
        height: 1,
      });
      const before = structuredClone(original);
      const id = original[kind][0]!.id;
      const changed = removeElement(original, { kind, id });
      expect(changed[kind].some((item) => item.id === id)).toBe(false);
      expect(original).toEqual(before);
      expect(buildingError(changed, false)).toBeNull();
    },
  );

  it("deleting a partition removes its door references and preserves the other geometry", () => {
    const original = fixture();
    const removed = removeElement(original, { kind: "walls", id: "partition" });
    expect(removed.doors).toEqual([]);
    expect(removed.exits).toEqual(original.exits);
    expect(removed.spawn_zones).toEqual(original.spawn_zones);
    expect(original.doors).toHaveLength(2);
  });

  it("allows removing the final exit in a draft while preventing simulation submission", () => {
    const original = fixture();
    original.exits = [original.exits[0]!];
    original.blocked_exit_ids = ["west"];
    const removed = removeElement(original, { kind: "exits", id: "west" });
    expect(removed.blocked_exit_ids).toEqual([]);
    expect(buildingError(removed, false)).toBeNull();
    expect(buildingError(removed)).toMatch(/exit/);
  });

  it.each([
    "missing-wall",
    "overrun",
    "negative-offset",
    "zero-width",
    "overlap",
  ])("rejects invalid opening edits: %s", (problem) => {
    const changed = fixture();
    const door = changed.doors[0]!;
    if (problem === "missing-wall") door.wall_id = "unknown";
    if (problem === "overrun") door.offset = 16;
    if (problem === "negative-offset") door.offset = -0.1;
    if (problem === "zero-width") door.width = 0;
    if (problem === "overlap") door.offset = changed.doors[1]!.offset;
    expect(buildingError(changed)).not.toBeNull();
  });

  it.each([
    "duplicate-id",
    "missing-exit",
    "duplicate-blocker",
    "obstructed-spawn",
    "zero-count",
    "fractional-count",
  ])("rejects incompatible layout edits: %s", (problem) => {
    const changed = fixture();
    if (problem === "duplicate-id")
      changed.spawn_zones[0]!.id = changed.walls[0]!.id;
    if (problem === "missing-exit") changed.blocked_exit_ids = ["unknown"];
    if (problem === "duplicate-blocker")
      changed.blocked_exit_ids = ["west", "west"];
    if (problem === "obstructed-spawn")
      changed.obstructions = [
        { id: "obstacle", x: 5, y: 5, width: 1, height: 1 },
      ];
    if (problem === "zero-count") changed.spawn_zones[0]!.count = 0;
    if (problem === "fractional-count") changed.spawn_zones[0]!.count = 1.5;
    expect(buildingError(changed)).not.toBeNull();
  });
});
