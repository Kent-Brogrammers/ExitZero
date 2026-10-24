import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import { buildingError, removeElement } from "./geometry";
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
});
