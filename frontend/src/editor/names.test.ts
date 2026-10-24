import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import schema from "../../../shared/schemas/contracts.schema.json";
import mock from "../../../shared/examples/simulation.mock.json";
import type { BuildingScenario } from "../types/simulation";
import { createApiClient } from "../services/api";
import { buildingError } from "./geometry";
import {
  nameProblem,
  nextObjectName,
  objectName,
  renameObject,
  withoutObjectNames,
} from "./names";
import { addObject } from "./shapes";

const validate = new Ajv({ allErrors: true }).compile(schema);
const kinds = [
  "walls",
  "doors",
  "exits",
  "spawn_zones",
  "obstructions",
] as const;
function fixture(): BuildingScenario {
  return {
    ...structuredClone(example),
    blocked_exit_ids: ["west"],
    obstructions: [{ id: "obstacle", x: 20, y: 8, width: 1, height: 1 }],
  };
}

describe("persistent display names", () => {
  it.each(kinds)(
    "renames %s without changing IDs, geometry, references, or population",
    (kind) => {
      const original = fixture();
      const selection = { kind, id: original[kind][0]!.id };
      const named = renameObject(original, selection, "  Main area  ");
      expect(objectName(named, selection)).toBe("Main area");
      expect(named[kind][0]!.id).toBe(selection.id);
      expect(withoutObjectNames(named)).toEqual(original);
      expect(original[kind][0]!.name).toBeUndefined();
      expect(buildingError(named)).toBeNull();
      expect(named.blocked_exit_ids).toEqual(["west"]);
      const json: unknown = JSON.parse(JSON.stringify(named));
      expect(validate(json), JSON.stringify(validate.errors)).toBe(true);
      expect(json).toEqual(named);
      expect(
        objectName(renameObject(named, selection, "Second name"), selection),
      ).toBe("Second name");
    },
  );
  it("supports old unnamed layouts and collision-free defaults without changing stable IDs", () => {
    const b = fixture();
    expect(validate(b)).toBe(true);
    expect(objectName(b, { kind: "walls", id: "north" })).toBe("Wall 1");
    expect(nextObjectName(b, "walls")).toBe("Wall 7");
    b.walls[0]!.name = "Wall 7";
    expect(nextObjectName(b, "walls")).toBe("Wall 1");
    expect(b.walls[0]!.id).toBe("north");
  });
  it.each([true, false])(
    "persists sensible generic object defaults (square=%s)",
    (square) => {
      const first = addObject(
        fixture(),
        { x: 20, y: 4 },
        { x: 21, y: 5 },
        square,
        "first",
      );
      const next = addObject(
        first,
        { x: 23, y: 4 },
        { x: 24, y: 5 },
        square,
        "second",
      );
      expect(first.obstructions.at(-1)!.name).toBe("Object 1");
      expect(next.obstructions.at(-1)!.name).toBe("Object 2");
      expect(validate(JSON.parse(JSON.stringify(next)))).toBe(true);
      expect(next.obstructions.at(-1)!.id).toBe("second");
    },
  );
  it.each(["", " \t\n", "\u00a0\u2003", "\u0085", "\ufeff", "x".repeat(81)])(
    "rejects invalid edited names (%j)",
    (value) => {
      const b = fixture();
      expect(nameProblem(value)).not.toBeNull();
      expect(() =>
        renameObject(b, { kind: "walls", id: "north" }, value),
      ).toThrow();
      expect(b.walls[0]!.name).toBeUndefined();
    },
  );
  it("counts Unicode characters consistently with the schema", () => {
    const eighty = "🧱".repeat(80);
    expect(nameProblem(eighty)).toBeNull();
    const named = renameObject(
      fixture(),
      { kind: "walls", id: "north" },
      eighty,
    );
    expect(validate(named)).toBe(true);
    expect(nameProblem(eighty + "🧱")).not.toBeNull();
  });
  it.each(kinds)(
    "rejects unsupported names in imported %s rather than dropping them",
    (kind) => {
      for (const name of [
        null,
        42,
        "",
        "  ",
        "\u0085",
        "\ufeff",
        "x".repeat(81),
      ]) {
        const json = JSON.parse(JSON.stringify(fixture()));
        json[kind][0].name = name;
        expect(validate(json)).toBe(false);
        expect(buildingError(json, false)).not.toBeNull();
      }
      const json = JSON.parse(JSON.stringify(fixture()));
      json[kind][0].display_label = "unsupported";
      expect(validate(json)).toBe(false);
    },
  );
  it("continues sending supported building JSON including names to the existing API", async () => {
    let b = fixture();
    for (const kind of kinds)
      b = renameObject(b, { kind, id: b[kind][0]!.id }, `Named ${kind}`);
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mock), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await createApiClient("/api").simulate(b);
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(body).toEqual(b);
    expect(withoutObjectNames(body)).toEqual(fixture());
  });
});

it("renames approved stair areas without changing their identifiers, orientation, geometry, or occupants", () => {
  const b = fixture();
  b.stair_areas = [
    {
      id: "stair",
      name: "Original stair",
      x: 20,
      y: 4,
      width: 2,
      height: 3,
      orientation_degrees: 90,
    },
  ];
  const named = renameObject(
    b,
    { kind: "stair_areas", id: "stair" },
    "  North Stair  ",
  );
  expect(objectName(named, { kind: "stair_areas", id: "stair" })).toBe(
    "North Stair",
  );
  expect(withoutObjectNames(named)).toEqual(withoutObjectNames(b));
  expect(validate(JSON.parse(JSON.stringify(named)))).toBe(true);
  expect(named.stair_areas![0]!.orientation_degrees).toBe(90);
  expect(b.stair_areas[0]!.name).toBe("Original stair");
});
