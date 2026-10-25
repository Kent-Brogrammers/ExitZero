import { describe, it, expect } from "vitest";
import example from "../../../shared/examples/building.json";
import { furniturePresets, furnitureKind, addFurniture } from "./furniture";
import { buildingError } from "./geometry";
import { renameObject } from "./names";
import { moveSelection, removeSelection, resizeSelection } from "./selection";
const blank = () => ({
  ...structuredClone(example),
  walls: [],
  doors: [],
  exits: [],
  spawn_zones: [],
  obstructions: [],
  blocked_exit_ids: [],
});
describe("small furniture presets using existing rectangular obstacles", () => {
  it.each(Object.keys(furniturePresets) as (keyof typeof furniturePresets)[])(
    "places and serializes a named physical %s without unsupported metadata",
    (kind) => {
      const original = blank(),
        b = addFurniture(original, kind, { x: 5, y: 5 }, undefined, "stable");
      const item = b.obstructions[0]!,
        preset = furniturePresets[kind];
      expect(item).toMatchObject({
        id: "stable",
        name: `${preset.label} 1`,
        width: preset.width,
        height: preset.height,
      });
      expect(Object.keys(item).sort()).toEqual([
        "height",
        "id",
        "name",
        "width",
        "x",
        "y",
      ]);
      expect(buildingError(b, false)).toBeNull();
      expect(original.obstructions).toEqual([]);
      expect(JSON.parse(JSON.stringify(b))).toEqual(b);
    },
  );
  it("supports free footprint sizing, meaningful renaming, movement and deletion with stable IDs", () => {
    const b = addFurniture(
      blank(),
      "desk",
      { x: 3, y: 4 },
      { x: 5, y: 5 },
      "desk",
    );
    const selection = { kind: "obstructions" as const, id: "desk" };
    const named = renameObject(b, selection, "Study desk");
    const moved = moveSelection(named, [selection], { x: 1, y: 2 });
    const resized = resizeSelection(moved, [selection], 3, 1.5);
    expect(resized.obstructions[0]).toMatchObject({
      id: "desk",
      name: "Study desk",
      x: 4,
      y: 6,
      width: 3,
      height: 1.5,
    });
    expect(buildingError(resized, false)).toBeNull();
    expect(removeSelection(resized, [selection]).obstructions).toEqual([]);
    expect(b.obstructions[0]!.name).toBe("Desk 1");
  });
  it("fits default footprints into workspace edges and identifies the explicit physical chair style", () => {
    const b = addFurniture(blank(), "bench", { x: 0, y: 0 });
    expect(b.obstructions[0]!.x).toBe(0);
    expect(b.obstructions[0]!.y).toBe(0);
    expect(buildingError(b, false)).toBeNull();
    expect(furnitureKind("furniture-chair")).toBe("chair");
    expect(furnitureKind("object-rectangle")).toBeNull();
    expect(furnitureKind("furniture-desk")).toBe("desk");
  });
});
