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
