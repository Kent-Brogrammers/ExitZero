import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario, WindowFrameState } from "../types/simulation";
import {
  buildingError,
  openingSegment,
  translateElement,
  removeElement,
} from "./geometry";
import { hitOpening, solidWallSegments } from "./openings";
import { mergeEditedOpenings } from "./doorEditing";
import { renameObject, nextObjectName } from "./names";
import {
  marqueeSelection,
  moveSelection,
  removeSelection,
  resizeSelection,
} from "./selection";

function draft(): BuildingScenario {
  return {
    ...structuredClone(example),
    walls: [
      {
        id: "wall",
        start: { x: 2, y: 2 },
        end: { x: 18, y: 14 },
        thickness: 0.2,
      },
    ],
    doors: [],
    exits: [],
    spawn_zones: [],
    obstructions: [],
    blocked_exit_ids: [],
    windows: [
      {
        id: "pane",
        name: "Window 1",
        wall_id: "wall",
        offset: 3,
        width: 2,
        emergency_escape: {
          enabled: false,
          preparation: "open",
          clear_width_metres: 1.6,
          clear_height_metres: 1.2,
          preparation_seconds: 5,
          traversal_seconds: 3,
          exterior_side: -1,
          exterior_available: false,
        },
      },
    ],
  };
}
const selected = { kind: "windows", id: "pane" } as const;

describe("persistent wall-attached windows", () => {
  it("round-trips optional config, names and stable IDs while legacy JSON still validates", () => {
    const b = draft();
    expect(buildingError(b, false)).toBeNull();
    expect(JSON.parse(JSON.stringify(b))).toEqual(b);
    expect(buildingError(example)).toBeNull();
    expect(nextObjectName(b, "windows")).toBe("Window 2");
    const renamed = renameObject(b, selected, "East escape window");
    expect(renamed.windows![0]!.id).toBe("pane");
    expect(renamed.windows![0]!.emergency_escape).toEqual(
      b.windows![0]!.emergency_escape,
    );
  });
  it.each(["doors", "exits", "windows"] as const)(
    "rejects overlapping %s without merging or changing window IDs",
    (kind) => {
      const b = draft();
      const candidate = {
        ...b,
        [kind]: [
          ...(b[kind] ?? []),
          { id: "overlap", wall_id: "wall", offset: 4, width: 2 },
        ],
      };
      const merged = mergeEditedOpenings(b, candidate).building;
      expect(buildingError(merged, false)).toMatch(/overlap/);
      expect(merged.windows![0]!.id).toBe("pane");
    },
  );
  it("permits touching distinct windows but rejects off-wall and unusable dimensions", () => {
    const b = draft();
    b.windows!.push({ id: "second", wall_id: "wall", offset: 5, width: 2 });
    expect(buildingError(b, false)).toBeNull();
    expect(mergeEditedOpenings(draft(), b).building.windows).toHaveLength(2);
    b.windows![1]!.offset = 19;
    expect(buildingError(b, false)).toMatch(/fit/);
    const invalid = draft();
    invalid.windows![0]!.emergency_escape!.clear_width_metres = 3;
    expect(buildingError(invalid, false)).toMatch(/usable width/);
  });
  it("selects angled windows, moves along their wall and carries them with parent movement", () => {
    const b = draft(),
      wall = b.walls[0]!,
      pane = b.windows![0]!;
    const [a, c] = openingSegment(pane, wall);
    expect(
      hitOpening(b, { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }, 0.1),
    ).toEqual(selected);
    const moved = translateElement(b, selected, { x: 0.8, y: 0.6 });
    expect(moved.windows![0]!.offset).toBeCloseTo(4);
    expect(moved.windows![0]!.id).toBe("pane");
    const together = moveSelection(
      b,
      [{ kind: "walls", id: "wall" }, selected],
      { x: 1, y: 1 },
    );
    expect(together.windows).toEqual(b.windows);
    expect(together.walls[0]!.start).toEqual({ x: 3, y: 3 });
  });
  it("includes windows in marquee, grouped resize and parent deletion", () => {
    const b = draft();
    expect(
      marqueeSelection(b, { x: 0, y: 0, width: 25, height: 19 }),
    ).toContainEqual(selected);
    const resized = resizeSelection(b, [{ kind: "walls", id: "wall" }], 20, 15);
    expect(resized.windows![0]!.width).toBeCloseTo(2.5);
    expect(
      resized.windows![0]!.emergency_escape!.clear_width_metres,
    ).toBeCloseTo(2);
    expect(removeElement(b, { kind: "walls", id: "wall" }).windows).toEqual([]);
    expect(removeSelection(b, [selected]).windows).toEqual([]);
  });
  it("keeps intact glazing solid and uses only recorded open/broken state for the centered clear aperture", () => {
    const b = draft(),
      wall = b.walls[0]!;
    const state: WindowFrameState = {
      window_id: "pane",
      state: "opening",
      preparation_ready_step: 50,
      queue_agent_ids: [7],
      traversing_agent_id: null,
      traversal_earliest_finish_step: null,
    };
    expect(solidWallSegments(b, wall)).toHaveLength(1);
    expect(solidWallSegments(b, wall, [state])).toHaveLength(1);
    for (const phase of ["open", "broken"] as const) {
      const pieces = solidWallSegments(b, wall, [{ ...state, state: phase }]);
      expect(pieces).toHaveLength(2);
      expect(
        Math.hypot(
          pieces[1]![0].x - pieces[0]![1].x,
          pieces[1]![0].y - pieces[0]![1].y,
        ),
      ).toBeCloseTo(1.6);
    }
    expect(b.windows![0]!.emergency_escape!.enabled).toBe(false);
  });
});
