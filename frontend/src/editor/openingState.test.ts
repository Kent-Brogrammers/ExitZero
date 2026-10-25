import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import { buildingError } from "./geometry";
import { openingStartsBlocked, setOpeningBlocked } from "./openingState";
import { mergeEditedOpenings, snapOpeningToNeighbor } from "./doorEditing";
import { solidWallSegments, openingLabels } from "./openings";

describe("initial door and exit blocking", () => {
  it.each(["doors", "exits"] as const)(
    "toggles %s through existing JSON fields without modifying geometry or IDs",
    (kind) => {
      const original: BuildingScenario = structuredClone(example);
      const id = original[kind][0]!.id;
      const snapshot = JSON.stringify(original);
      expect(openingStartsBlocked(original, id)).toBe(false);
      const blocked = setOpeningBlocked(original, kind, id, true);
      expect(openingStartsBlocked(blocked, id)).toBe(true);
      expect(blocked[kind]).toBe(original[kind]);
      expect(blocked.walls).toBe(original.walls);
      expect(blocked.spawn_zones).toBe(original.spawn_zones);
      const repeated = setOpeningBlocked(blocked, kind, id, true);
      expect(repeated).toEqual(blocked);
      expect(
        repeated.blocked_exit_ids.filter((value) => value === id),
      ).toHaveLength(kind === "exits" ? 1 : 0);
      expect(
        repeated.opening_events?.filter(
          (event) => event.opening_id === id && event.step === 0,
        ) ?? [],
      ).toHaveLength(kind === "doors" ? 1 : 0);
      const restored: BuildingScenario = JSON.parse(JSON.stringify(blocked));
      expect(buildingError(restored)).toBeNull();
      expect(openingStartsBlocked(restored, id)).toBe(true);
      const open = setOpeningBlocked(restored, kind, id, false);
      expect(openingStartsBlocked(open, id)).toBe(false);
      expect(buildingError(open)).toBeNull();
      expect(JSON.stringify(original)).toBe(snapshot);
    },
  );

  it.each(["doors", "exits"] as const)(
    "replaces only the selected %s initial event and preserves all later schedules",
    (kind) => {
      const b: BuildingScenario = structuredClone(example);
      const id = b[kind][0]!.id;
      const other = kind === "doors" ? b.exits[0]!.id : b.doors[0]!.id;
      b.blocked_exit_ids = kind === "exits" ? [id] : [];
      b.opening_events = [
        { step: 0, opening_id: other, blocked: true },
        { step: 0, opening_id: id, blocked: false },
        { step: 20, opening_id: id, blocked: false },
        { step: 30, opening_id: other, blocked: false },
        { step: 40, opening_id: id, blocked: true },
      ];
      expect(openingStartsBlocked(b, id)).toBe(false);
      for (const blocked of [true, false, true]) {
        const changed = setOpeningBlocked(b, kind, id, blocked);
        expect(openingStartsBlocked(changed, id)).toBe(blocked);
        expect(
          changed.opening_events?.filter((event) => event.step > 0),
        ).toEqual(b.opening_events.filter((event) => event.step > 0));
        expect(
          changed.opening_events?.filter((event) => event.opening_id === other),
        ).toEqual(
          b.opening_events.filter((event) => event.opening_id === other),
        );
        expect(buildingError(changed)).toBeNull();
      }
    },
  );

  it("does not treat later closures as initially blocked or invent events for missing IDs", () => {
    const b: BuildingScenario = {
      ...example,
      opening_events: [{ step: 10, opening_id: "door_north", blocked: true }],
    };
    expect(openingStartsBlocked(b, "door_north")).toBe(false);
    expect(setOpeningBlocked(b, "doors", "missing", true)).toBe(b);
  });

  it("keeps scheduled doors distinct and rejects snapping/merging mixed initial states", () => {
    const b: BuildingScenario = {
      ...example,
      doors: [{ ...example.doors[0]!, id: "closed", offset: 2, width: 1 }],
      opening_events: [{ step: 0, opening_id: "closed", blocked: true }],
    };
    const next = {
      ...b,
      doors: [...b.doors, { ...b.doors[0]!, id: "open", offset: 3 }],
    };
    expect(mergeEditedOpenings(b, next).error).toMatch(
      /different blocked states/,
    );
    expect(
      snapOpeningToNeighbor(
        {
          ...next,
          doors: next.doors.map((door) =>
            door.id === "open" ? { ...door, offset: 3.05 } : door,
          ),
        },
        "doors",
        "open",
        0.1,
      ).snapped,
    ).toBe(false);
    const both = setOpeningBlocked(next, "doors", "open", true);
    const edit = mergeEditedOpenings(b, both);
    expect(edit.error).toBeNull();
    expect(edit.building.doors).toEqual(both.doors);
    expect(edit.building.opening_events).toEqual(both.opening_events);
  });

  it("renders configured closures as solid angled wall intervals and labels", () => {
    const wall = {
      id: "diagonal",
      start: { x: 1, y: 2 },
      end: { x: 7, y: 10 },
      thickness: 0.2,
    };
    const b: BuildingScenario = {
      ...example,
      walls: [wall],
      doors: [{ id: "door", wall_id: wall.id, offset: 2, width: 2 }],
      exits: [],
      blocked_exit_ids: [],
    };
    const closed = setOpeningBlocked(b, "doors", "door", true);
    expect(solidWallSegments(closed, wall)).toEqual([[wall.start, wall.end]]);
    expect(openingLabels(closed, 0.02, () => 1)[0]!.text).toBe(
      "Blocked door · 2.0 m",
    );
    expect(
      solidWallSegments(
        setOpeningBlocked(closed, "doors", "door", false),
        wall,
      ),
    ).toHaveLength(2);
  });
});
