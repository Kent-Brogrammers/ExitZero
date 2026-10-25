import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario, Opening } from "../types/simulation";
import { buildingError, openingSegment } from "./geometry";
import { mergeEditedDoors, snapDoorToNeighbor } from "./doorEditing";
import { openingLabels, solidWallSegments } from "./openings";
const door = (id: string, offset: number, width = 1): Opening => ({
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
    doors: [door("a", 2)],
    exits: [],
    spawn_zones: [],
    obstructions: [],
    blocked_exit_ids: [],
  };
}
describe("edited adjacent doors", () => {
  it.each([false, true])(
    "merges two contacts to one stable ID, gap and label (angled=%s)",
    (angled) => {
      const before = fixture(angled),
        original = structuredClone(before);
      const edit = mergeEditedDoors(before, {
        ...before,
        doors: [...before.doors, door("new", 3, 2)],
      });
      expect(edit.building.doors).toEqual([door("a", 2, 3)]);
      expect(edit.replacements.get("new")).toBe("a");
      expect(edit.building.walls).toEqual(before.walls);
      expect(
        solidWallSegments(edit.building, edit.building.walls[0]!),
      ).toHaveLength(2);
      expect(openingLabels(edit.building, 0.02, () => 1)).toHaveLength(1);
      expect(buildingError(edit.building, false)).toBeNull();
      expect(JSON.parse(JSON.stringify(edit.building))).toEqual(edit.building);
      expect(before).toEqual(original);
      const [start, end] = openingSegment(
        edit.building.doors[0]!,
        edit.building.walls[0]!,
      );
      expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeCloseTo(3);
    },
  );
  it("merges a transitive chain and retains the selected existing ID/name", () => {
    const before = fixture();
    before.doors.push(door("b", 4));
    const edit = mergeEditedDoors(
      before,
      { ...before, doors: [...before.doors, door("bridge", 3)] },
      "b",
    );
    expect(edit.building.doors).toEqual([door("b", 2, 3)]);
    expect([...edit.replacements]).toEqual([
      ["a", "b"],
      ["bridge", "b"],
    ]);
  });
  it.each(["move", "resize"])(
    "merges after %s as one reversible before/after transaction",
    (kind) => {
      const before = fixture();
      before.doors.push(door("b", 4));
      const next = structuredClone(before);
      if (kind === "move") next.doors[1]!.offset = 3;
      else next.doors[0]!.width = 2;
      const edit = mergeEditedDoors(before, next, kind === "move" ? "b" : "a");
      expect(edit.building.doors).toHaveLength(1);
      expect(edit.building.doors[0]!.id).toBe(kind === "move" ? "b" : "a");
      expect(before.doors).toEqual([door("a", 2), door("b", 4)]);
    },
  );
  it("leaves a real separator intact and does not normalize imported contacts on unrelated edits", () => {
    const before = fixture();
    const separated = { ...before, doors: [...before.doors, door("b", 3.001)] };
    expect(mergeEditedDoors(before, separated).building.doors).toHaveLength(2);
    const imported = { ...before, doors: [...before.doors, door("b", 3)] };
    const named = structuredClone(imported);
    named.doors[0]!.name = "Renamed";
    expect(mergeEditedDoors(imported, named).building.doors).toHaveLength(2);
  });
  it("keeps exits, blocked references and physically coincident different walls separate", () => {
    const before = fixture();
    before.walls.push({ ...before.walls[0]!, id: "other" });
    before.exits = [{ ...door("exit", 8), width: 2 }];
    before.blocked_exit_ids = ["exit"];
    const next = {
      ...before,
      doors: [
        ...before.doors,
        { ...door("different-wall", 3), wall_id: "other" },
        door("near-exit", 7),
      ],
    };
    const edit = mergeEditedDoors(before, next);
    expect(edit.building.doors).toHaveLength(3);
    expect(edit.building.exits).toEqual(before.exits);
    expect(edit.building.blocked_exit_ids).toEqual(["exit"]);
  });
  it.each([2.9, 19.5])(
    "rejects invalid overlap/out-of-wall edits at %s before merging",
    (offset) => {
      const before = fixture(),
        next = { ...before, doors: [...before.doors, door("invalid", offset)] };
      const edit = mergeEditedDoors(before, next);
      expect(edit.replacements.size).toBe(0);
      expect(buildingError(edit.building, false)).not.toBeNull();
    },
  );
  it("never deletes an ID referenced by malformed blocked-exit data", () => {
    const before = fixture(),
      next = {
        ...before,
        doors: [...before.doors, door("new", 3)],
        blocked_exit_ids: ["new"],
      };
    expect(mergeEditedDoors(before, next).building.doors).toHaveLength(2);
    expect(buildingError(next, false)).toMatch(/Blocked/);
  });
});
describe("explicit snap-and-merge preview", () => {
  it.each([false, true])(
    "snaps only within the configured metre tolerance and preserves inputs (angled=%s)",
    (angled) => {
      const before = fixture(angled),
        candidate = { ...before, doors: [...before.doors, door("new", 3.08)] };
      expect(snapDoorToNeighbor(candidate, "new", 0.05).snapped).toBe(false);
      const snap = snapDoorToNeighbor(candidate, "new", 0.1);
      expect(snap.snapped).toBe(true);
      expect(candidate.doors[1]!.offset).toBe(3.08);
      expect(snap.building.doors[1]!.offset).toBe(3);
      expect(mergeEditedDoors(before, snap.building).building.doors).toEqual([
        door("a", 2, 2),
      ]);
      expect(snap.building.doors[1]!.width).toBe(1);
    },
  );
  it("cannot snap to exits, overrun bounds or overlap a third opening", () => {
    const b = fixture();
    b.exits = [{ ...door("exit", 3.08), width: 2 }];
    expect(snapDoorToNeighbor(b, "a", 0.1).snapped).toBe(false);
    const invalid = {
      ...b,
      exits: [],
      doors: [door("a", 0, 0.5), door("b", 0.6, 1)],
    };
    expect(
      snapDoorToNeighbor(invalid, "b", 0.2).building.doors.every(
        (d) => d.offset >= 0,
      ),
    ).toBe(true);
    expect(snapDoorToNeighbor(b, "a", NaN).snapped).toBe(false);
    const crowded = {
      ...b,
      exits: [],
      doors: [door("left", 2), door("moving", 3.08), door("right", 3.9)],
    };
    expect(snapDoorToNeighbor(crowded, "moving", 0.2).snapped).toBe(false);
  });
});
