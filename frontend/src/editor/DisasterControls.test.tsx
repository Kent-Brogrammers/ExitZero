import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import { ScenarioFields as DisasterControls } from "./DisasterControls";
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
      "place hazard on plan",
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

  it("preserves shelter limits across edits and JSON and rejects invalid limits", () => {
    const building = fixture();
    building.tornado_zones = [
      { id: "shelter", x: 20, y: 10, width: 2, height: 2, max_occupants: 12 },
    ];
    const moved = moveSelection(
      building,
      [{ kind: "tornado_zones", id: "shelter" }],
      { x: 1, y: 0 },
    );
    const restored = JSON.parse(JSON.stringify(moved)) as BuildingScenario;
    expect(restored.tornado_zones![0]!.max_occupants).toBe(12);
    expect(buildingError(restored)).toBeNull();
    for (const limit of [0, -1, 1.5, 10001, null, "12"]) {
      const invalid = structuredClone(restored);
      Object.assign(invalid.tornado_zones![0]!, { max_occupants: limit });
      expect(buildingError(invalid)).toContain(
        "whole number between 1 and 10,000",
      );
    }
    delete restored.tornado_zones![0]!.max_occupants;
    expect(buildingError(restored)).toBeNull();
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
  building.disaster = {
    kind: "gas_leak",
    center: { x: 5, y: 5 },
    radius: 1,
    dynamics: defaultDynamics("gas_leak", 1),
  };
  html = renderToStaticMarkup(
    <DisasterControls
      building={building}
      onChange={() => {}}
      onLocate={() => {}}
    />,
  );
  expect(html).toContain("Cloud growth settings");
  expect(html).toContain("Maximum cloud radius (ft)");
  expect(html).not.toContain("New patch every (s)");
  expect(html).not.toContain("Maximum patches");
  expect(defaultDynamics("gas_leak", 1).max_patches).toBe(1);
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
