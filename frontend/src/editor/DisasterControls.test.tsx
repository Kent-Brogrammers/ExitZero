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
    "Growth rate (m/s)",
    "New patch every (s)",
    "Maximum patches",
    "Maximum patch radius (m)",
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
    "Speed (m/s)",
    "Turning speed (deg/s)",
    "Extra shelter clearance (m)",
  ])
    expect(html).toContain(label);
  expect(html).not.toContain("Growth rate (m/s)");
  expect(buildingError(building)).toBeNull();
  building.disaster.dynamics!.speed = 11;
  expect(buildingError(building)).not.toBeNull();
  expect(defaultDynamics("gas_leak", 1).growth_rate).toBeGreaterThan(
    defaultDynamics("fire", 1).growth_rate,
  );
});
