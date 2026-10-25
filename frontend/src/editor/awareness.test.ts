import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import { buildingError, removeElement } from "./geometry";
import { mergeEditedOpenings } from "./doorEditing";
import { removeSelection } from "./selection";
import type { BuildingScenario } from "../types/simulation";

describe("awareness settings and scheduled opening changes", () => {
  const building: BuildingScenario = {
    ...example,
    awareness: { sight_range_metres: 8, communication_range_metres: 0 },
    opening_events: [
      { step: 20, opening_id: "door_north", blocked: true },
      { step: 30, opening_id: "west", blocked: false },
    ],
  };
  it("accepts local communication settings and references to doors and exits", () => {
    expect(buildingError(building)).toBeNull();
  });
  it("rejects invalid ranges, missing openings, duplicate changes, and unsorted events", () => {
    for (const invalid of [
      {
        ...building,
        awareness: { sight_range_metres: 8, communication_range_metres: -1 },
      },
      {
        ...building,
        opening_events: [{ step: 1, opening_id: "missing", blocked: true }],
      },
      {
        ...building,
        opening_events: [
          { step: building.max_steps, opening_id: "west", blocked: true },
        ],
      },
      {
        ...building,
        opening_events: [
          building.opening_events![1]!,
          building.opening_events![0]!,
        ],
      },
      {
        ...building,
        opening_events: [
          building.opening_events![0]!,
          building.opening_events![0]!,
        ],
      },
    ])
      expect(buildingError(invalid)).not.toBeNull();
  });
  it("removes schedules referencing deleted openings or their parent wall", () => {
    expect(
      removeElement(building, { kind: "doors", id: "door_north" })
        .opening_events,
    ).toEqual([building.opening_events![1]]);
    expect(
      removeSelection(building, [{ kind: "walls", id: "west_wall" }])
        .opening_events,
    ).toEqual([building.opening_events![0]]);
  });
  it.each(["doors", "exits"] as const)(
    "preserves scheduled IDs when touching %s would merge",
    (kind) => {
      const before = structuredClone(building);
      const survivor = before[kind][0]!;
      const adjacent = {
        ...survivor,
        id: "scheduled-adjacent",
        offset: survivor.offset + survivor.width,
        width: 0.5,
      };
      const candidate: BuildingScenario = {
        ...before,
        [kind]: [...before[kind], adjacent],
        opening_events: [
          ...before.opening_events!,
          { step: 40, opening_id: adjacent.id, blocked: true },
        ],
        blocked_exit_ids: kind === "exits" ? [survivor.id, adjacent.id] : [],
      };
      const edit = mergeEditedOpenings(before, candidate, survivor.id);
      expect(edit.error).toBeNull();
      expect(edit.replacements.size).toBe(0);
      expect(edit.building[kind]).toEqual(candidate[kind]);
      expect(edit.building.opening_events).toEqual(candidate.opening_events);
      expect(buildingError(edit.building)).toBeNull();
    },
  );
  it.each(["doors", "exits"] as const)(
    "allows merging %s when schedules reference the surviving ID",
    (kind) => {
      const before = structuredClone(building);
      const survivor = before[kind][0]!;
      const candidate: BuildingScenario = {
        ...before,
        [kind]: [
          ...before[kind],
          {
            ...survivor,
            id: "new-adjacent",
            offset: survivor.offset + survivor.width,
            width: 0.5,
          },
        ],
        blocked_exit_ids: kind === "exits" ? [survivor.id, "new-adjacent"] : [],
      };
      const edit = mergeEditedOpenings(before, candidate, survivor.id);
      expect(edit.error).toBeNull();
      expect(edit.replacements.get("new-adjacent")).toBe(survivor.id);
      expect(edit.building[kind]).toHaveLength(before[kind].length);
      expect(edit.building.opening_events).toEqual(before.opening_events);
      expect(edit.building.blocked_exit_ids).toEqual(
        kind === "exits" ? [survivor.id] : [],
      );
      expect(buildingError(edit.building)).toBeNull();
    },
  );
});
