import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import { DisasterControls } from "./DisasterControls";
import { buildingError } from "./geometry";
import { moveSelection, removeSelection } from "./selection";
import type { BuildingScenario } from "../types/simulation";

const fixture = (): BuildingScenario => structuredClone(example);

describe("catastrophe configuration and tornado zones", () => {
  it("offers all scenarios and location placement without exposing agent knowledge", () => {
    const building = fixture();
    building.disaster = { kind: "fire", center: { x: 5, y: 5 }, radius: 1 };
    const html = renderToStaticMarkup(
      <DisasterControls
        building={building}
        onChange={() => {}}
        onLocate={() => {}}
      />,
    );
    for (const label of [
      "Baseline evacuation",
      "Fire",
      "Gas leak",
      "Tornado",
      "Place hazard on plan",
      "Hazard radius",
    ])
      expect(html).toContain(label);
    expect(html).toContain("discover the location");
    expect(buildingError(building)).toBeNull();
    building.disaster.radius = -1;
    expect(buildingError(building)).not.toBeNull();
  });

  it("lets users draft tornado mode but requires a safe zone before running", () => {
    const building = fixture();
    building.disaster = { kind: "tornado", center: { x: 2, y: 2 }, radius: 1 };
    expect(buildingError(building, false)).toBeNull();
    expect(buildingError(building)).toContain("tornado zone");
    building.tornado_zones = [
      { id: "shelter", name: "Safe room", x: 20, y: 10, width: 2, height: 2 },
    ];
    expect(buildingError(building)).toBeNull();
    const moved = moveSelection(
      building,
      [{ kind: "tornado_zones", id: "shelter" }],
      { x: 1, y: 0 },
    );
    expect(moved.tornado_zones![0]!.x).toBe(21);
    expect(
      removeSelection(moved, [{ kind: "tornado_zones", id: "shelter" }])
        .tornado_zones,
    ).toEqual([]);
    building.disaster.center = { x: 21, y: 11 };
    expect(buildingError(building)).toContain("outside");
  });
});

it("exposes kind-specific evolution parameters and validates their bounds", async () => {
  const { defaultDynamics } = await import("./disasterDynamics");
  const building = fixture();
  building.disaster = {
    kind: "fire",
    center: { x: 5, y: 5 },
    radius: 1,
    dynamics: defaultDynamics("fire", 1),
  };
  let html = renderToStaticMarkup(
    <DisasterControls
      building={building}
      onChange={() => {}}
      onLocate={() => {}}
    />,
  );
  for (const label of [
    "Growth rate (ft/s)",
    "New patch every (s)",
    "Maximum patches",
    "Maximum patch radius (ft)",
    "Scenario random seed",
  ])
    expect(html).toContain(label);
  expect(buildingError(building)).toBeNull();
  building.disaster.dynamics!.max_patches = 65;
  expect(buildingError(building)).not.toBeNull();
  building.disaster.dynamics = defaultDynamics("fire", 1);
  building.disaster.dynamics.max_radius = 0.5;
  expect(buildingError(building)).toContain("initial radius");
  building.disaster = {
    kind: "tornado",
    center: { x: 2, y: 2 },
    radius: 0.5,
    dynamics: defaultDynamics("tornado", 0.5),
  };
  building.tornado_zones = [{ id: "safe", x: 20, y: 10, width: 2, height: 2 }];
  html = renderToStaticMarkup(
    <DisasterControls
      building={building}
      onChange={() => {}}
      onLocate={() => {}}
    />,
  );
  for (const label of [
    "Speed (ft/s)",
    "Turning speed (deg/s)",
    "Extra shelter clearance (ft)",
  ])
    expect(html).toContain(label);
  expect(html).not.toContain("Growth rate (ft/s)");
  expect(buildingError(building)).toBeNull();
  building.disaster.dynamics!.speed = 11;
  expect(buildingError(building)).not.toBeNull();
  expect(defaultDynamics("gas_leak", 1).growth_rate).toBeGreaterThan(
    defaultDynamics("fire", 1).growth_rate,
  );
});

it("uses a compact native radio group with one selected mode and feet-only distance labels", () => {
  for (const kind of [undefined, "fire", "gas_leak", "tornado"] as const) {
    const building = fixture();
    if (kind) building.disaster = { kind, center: { x: 5, y: 5 }, radius: 1 };
    const before = JSON.stringify(building);
    const html = renderToStaticMarkup(
      <DisasterControls
        building={building}
        onChange={() => {}}
        onLocate={() => {}}
      />,
    );
    expect(html).toContain("<legend>Scenario</legend>");
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).not.toContain("<select");
    expect(html).not.toContain("(m)");
    if (kind) {
      expect(html).toContain("Hazard radius (ft)");
      expect(html).toContain('value="3.2808"');
    }
    expect(JSON.stringify(building)).toBe(before);
  }
});
