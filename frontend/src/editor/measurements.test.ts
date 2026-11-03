import { expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import { measurementVisibility, wallLengthLabels } from "./measurements";
import { openingLabels } from "./openings";

it("retains existing opening widths by default and tolerates malformed/partial preferences", () => {
  const defaults = { walls: false, doors: true, windows: true, exits: true };
  expect(measurementVisibility()).toEqual(defaults);
  expect(measurementVisibility(null)).toEqual(defaults);
  expect(measurementVisibility("bad data")).toEqual(defaults);
  expect(
    measurementVisibility({
      walls: true,
      doors: "false",
      windows: null,
      exits: false,
    }),
  ).toEqual({ ...defaults, walls: true, exits: false });
});

it("measures full straight/angled wall centrelines and preserves all geometry and IDs", () => {
  const building = {
    ...example,
    walls: [
      {
        id: "horizontal",
        start: { x: 2, y: 2 },
        end: { x: 12, y: 2 },
        thickness: 0.2,
      },
      {
        id: "angled",
        start: { x: 2, y: 5 },
        end: { x: 5, y: 9 },
        thickness: 0.2,
      },
    ],
  };
  const before = JSON.stringify(building);
  const labels = wallLengthLabels(building, 0.04, (text) => text.length * 0.24);
  expect(labels.map((label) => [label.id, label.text])).toEqual([
    ["horizontal", "32.81 ft"],
    ["angled", "16.4 ft"],
  ]);
  expect(labels[0]!.anchor).toEqual({ x: 7, y: 2 });
  expect(JSON.stringify(building)).toBe(before);
});

it("positions wall lengths clear of nearby opening annotations", () => {
  const measure = (text: string) => text.length * 0.24;
  const openings = openingLabels(example, 0.04, measure);
  const walls = wallLengthLabels(example, 0.04, measure, openings);
  const placed = [...openings];
  for (const label of walls) {
    expect(
      placed.some(
        (p) =>
          label.x < p.x + p.width &&
          p.x < label.x + label.width &&
          label.y - label.height < p.y &&
          p.y - p.height < label.y,
      ),
    ).toBe(false);
    placed.push(label);
  }
});

it("retains blocked/window-state labels when their dimensions are switched off", () => {
  const building = { ...example, blocked_exit_ids: [example.exits[0]!.id] };
  const labels = openingLabels(
    building,
    0.04,
    (text) => text.length * 0.24,
    [],
    {
      measurements: {
        walls: false,
        doors: false,
        windows: false,
        exits: false,
      },
      showNames: true,
    },
  );
  expect(labels.some((label) => label.text === "Blocked exit")).toBe(true);
  expect(labels.some((label) => label.text.includes(" ft"))).toBe(false);
});

it("keeps small openings quiet until focused or zoomed in, retaining exits and blocked states", () => {
  const building = {
    ...example,
    doors: [
      { id: "small-door", wall_id: example.walls[0]!.id, offset: 2, width: 1 },
      {
        id: "blocked-door",
        wall_id: example.walls[0]!.id,
        offset: 6,
        width: 1,
      },
    ],
    windows: [
      {
        id: "small-window",
        wall_id: example.walls[0]!.id,
        offset: 10,
        width: 1,
      },
    ],
    opening_events: [{ step: 0, opening_id: "blocked-door", blocked: true }],
  };
  const before = JSON.stringify(building);
  const options = {
    measurements: measurementVisibility(),
    showNames: true,
    declutter: true,
  };
  const labelsAt = (px: number, focusIds?: Set<string>) =>
    openingLabels(building, px, (text) => text.length * 6 * px, [], {
      ...options,
      focusIds,
    });
  const quiet = labelsAt(0.08);
  expect(quiet.some((label) => label.id === "small-door")).toBe(false);
  expect(quiet.some((label) => label.id === "small-window")).toBe(false);
  expect(quiet.some((label) => label.text.startsWith("Blocked door"))).toBe(
    true,
  );
  expect(quiet.some((label) => label.id === example.exits[0]!.id)).toBe(true);
  expect(
    labelsAt(0.08, new Set(["small-door", "small-window"])).filter((label) =>
      label.id.startsWith("small-"),
    ),
  ).toHaveLength(2);
  expect(labelsAt(0.015).some((label) => label.id === "small-door")).toBe(true);
  const all = openingLabels(building, 0.08, (text) => text.length * 0.48, [], {
    ...options,
    declutter: false,
  });
  expect(all).toHaveLength(
    building.doors.length + building.exits.length + building.windows.length,
  );
  expect(JSON.stringify(building)).toBe(before);
});
