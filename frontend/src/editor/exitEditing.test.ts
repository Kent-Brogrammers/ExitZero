import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario, Opening } from "../types/simulation";
import { buildingError, openingSegment } from "./geometry";
import { mergeEditedOpenings, snapOpeningToNeighbor } from "./doorEditing";
import { openingLabels, solidWallSegments } from "./openings";
const exit = (id: string, offset: number, width = 1): Opening => ({
  id,
  name: `Named ${id}`,
  wall_id: "wall",
  offset,
  width,
});
function fixture(angled = false): BuildingScenario {
  return {
    ...structuredClone(example),
    walls: [
      {
        id: "wall",
        start: { x: 2, y: 2 },
        end: angled ? { x: 18, y: 14 } : { x: 22, y: 2 },
        thickness: 0.2,
      },
    ],
    doors: [],
    exits: [exit("a", 2)],
    spawn_zones: [],
    obstructions: [],
    blocked_exit_ids: [],
  };
}
describe("edited adjacent exits and reference integrity", () => {
  it.each([false, true])(
    "merges contact on actual straight/angled walls (angled=%s)",
    (angled) => {
      const before = fixture(angled),
        original = structuredClone(before);
      const edit = mergeEditedOpenings(before, {
        ...before,
        exits: [...before.exits, exit("new", 3, 2)],
      });
      expect(edit.error).toBeNull();
      expect(edit.building.exits).toEqual([exit("a", 2, 3)]);
      expect(edit.replacements.get("new")).toBe("a");
      expect(openingLabels(edit.building, 0.02, () => 1)).toHaveLength(1);
      expect(
        solidWallSegments(edit.building, edit.building.walls[0]!),
      ).toHaveLength(2);
      const [a, b] = openingSegment(
        edit.building.exits[0]!,
        edit.building.walls[0]!,
      );
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(3);
      expect(buildingError(edit.building, false)).toBeNull();
      expect(JSON.parse(JSON.stringify(edit.building))).toEqual(edit.building);
      expect(before).toEqual(original);
    },
  );
  it.each(["move", "resize"])(
    "merges after %s while keeping the selected existing name/ID",
    (kind) => {
      const before = fixture();
      before.exits.push(exit("b", 4));
      const next = structuredClone(before);
      if (kind === "move") next.exits[1]!.offset = 3;
      else next.exits[0]!.width = 2;
      const edit = mergeEditedOpenings(before, next, "b");
      expect(edit.building.exits).toEqual([
        exit("b", 2, kind === "move" ? 2 : 3),
      ]);
      expect(edit.replacements.get("a")).toBe("b");
      expect(before.exits).toEqual([exit("a", 2), exit("b", 4)]);
    },
  );
  it("remaps an entire blocked chain, deduplicates references and preserves unrelated blocked exits", () => {
    const before = fixture();
    before.exits = [exit("a", 2), exit("b", 4), exit("other", 10)];
    before.blocked_exit_ids = ["other", "a", "b"];
    const edit = mergeEditedOpenings(
      before,
      {
        ...before,
        exits: [...before.exits, exit("bridge", 3)],
        blocked_exit_ids: [...before.blocked_exit_ids, "bridge"],
      },
      "b",
    );
    expect(edit.building.exits).toEqual([exit("b", 2, 3), exit("other", 10)]);
    expect(edit.building.blocked_exit_ids).toEqual(["other", "b"]);
    expect(buildingError(edit.building, false)).toBeNull();
    expect(
      solidWallSegments(edit.building, edit.building.walls[0]!),
    ).toHaveLength(1);
  });
  it.each([{ blocked: ["a"] }, { blocked: ["new"] }])(
    "rejects mixed blocked states atomically (%s)",
    ({ blocked }) => {
      const before = fixture();
      const candidate = {
        ...before,
        exits: [...before.exits, exit("new", 3)],
        blocked_exit_ids: blocked,
      };
      const edit = mergeEditedOpenings(before, candidate);
      expect(edit.error).toMatch(/different blocked states/);
      expect(edit.replacements.size).toBe(0);
      expect(edit.building).toBe(candidate);
      expect(before.exits).toEqual([exit("a", 2)]);
    },
  );
  it("rejects a mixed-state bridge across a whole transitive component", () => {
    const before = fixture();
    before.exits.push(exit("b", 4));
    before.blocked_exit_ids = ["b"];
    const edit = mergeEditedOpenings(before, {
      ...before,
      exits: [...before.exits, exit("bridge", 3)],
    });
    expect(edit.error).toMatch(/different blocked states/);
    expect(edit.replacements.size).toBe(0);
  });
  it("does not rewrite imported contacts on renames or blocked-state changes alone", () => {
    const before = fixture();
    before.exits.push(exit("b", 3));
    const next = structuredClone(before);
    next.exits[0]!.name = "New name";
    next.blocked_exit_ids = ["a"];
    const edit = mergeEditedOpenings(before, next);
    expect(edit.error).toBeNull();
    expect(edit.building).toBe(next);
  });
  it("never merges doors with exits or openings on different actual wall IDs", () => {
    const before = fixture();
    before.doors = [exit("door", 6)];
    before.walls.push({ ...before.walls[0]!, id: "other" });
    const edit = mergeEditedOpenings(before, {
      ...before,
      exits: [
        ...before.exits,
        exit("near-door", 7),
        { ...exit("other-wall", 3), wall_id: "other" },
      ],
    });
    expect(edit.building.exits).toHaveLength(3);
    expect(edit.building.doors).toEqual(before.doors);
    expect(edit.replacements.size).toBe(0);
  });
  it.each([2.9, 19.5])(
    "does not hide invalid overlaps or wall overrun at %s",
    (offset) => {
      const before = fixture(),
        edit = mergeEditedOpenings(before, {
          ...before,
          exits: [...before.exits, exit("new", offset)],
        });
      expect(edit.replacements.size).toBe(0);
      expect(buildingError(edit.building, false)).not.toBeNull();
    },
  );
  it.each([false, true])(
    "snaps only compatible exits within metre tolerance (blocked=%s)",
    (blocked) => {
      const before = fixture(true);
      const b = {
        ...before,
        exits: [...before.exits, exit("moving", 3.08)],
        blocked_exit_ids: blocked ? ["a", "moving"] : [],
      };
      expect(snapOpeningToNeighbor(b, "exits", "moving", 0.05).snapped).toBe(
        false,
      );
      const snap = snapOpeningToNeighbor(b, "exits", "moving", 0.1);
      expect(snap.snapped).toBe(true);
      expect(snap.building.exits[1]!.offset).toBe(3);
      expect(b.exits[1]!.offset).toBe(3.08);
      const edit = mergeEditedOpenings(before, snap.building);
      expect(edit.building.exits).toEqual([exit("a", 2, 2)]);
      expect(edit.building.blocked_exit_ids).toEqual(blocked ? ["a"] : []);
    },
  );
  it("does not snap toward incompatible states, doors, or mixed-state bridge components", () => {
    const b = fixture();
    b.exits.push(exit("moving", 3.08));
    b.blocked_exit_ids = ["a"];
    expect(snapOpeningToNeighbor(b, "exits", "moving", 0.1).snapped).toBe(
      false,
    );
    b.blocked_exit_ids = [];
    b.exits = [exit("moving", 3.08)];
    b.doors = [exit("door", 2)];
    expect(snapOpeningToNeighbor(b, "exits", "moving", 0.1).snapped).toBe(
      false,
    );
    b.doors = [];
    b.exits = [exit("a", 2), exit("moving", 3.08), exit("blocked", 4)];
    b.blocked_exit_ids = ["blocked"];
    expect(snapOpeningToNeighbor(b, "exits", "moving", 0.1).snapped).toBe(
      false,
    );
  });
});
