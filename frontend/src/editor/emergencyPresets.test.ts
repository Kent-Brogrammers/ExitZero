import { describe, expect, it } from "vitest";
import { emergencyPresets } from "./emergencyPresets";
import { buildingPresets } from "./presets";
import { buildingError } from "./geometry";
import { createTemplate } from "../templates/templates";

describe("editable emergency setups", () => {
  it.each(emergencyPresets)(
    "validates and round-trips $label without results or manual closures",
    (preset) => {
      expect(buildingError(preset.building)).toBeNull();
      expect(JSON.parse(JSON.stringify(preset.building))).toEqual(
        preset.building,
      );
      expect(preset.building.blocked_exit_ids).toEqual([]);
      expect(preset.building.opening_events ?? []).toEqual([]);
      if (preset.building.disaster)
        expect(preset.building.disaster.dynamics?.enabled).toBe(true);
      expect(
        preset.building.spawn_zones.reduce((n, s) => n + s.count, 0),
      ).toBeGreaterThan(0);
      expect("frames" in preset.building).toBe(false);
      expect("traffic_samples" in preset.building).toBe(false);
      const before = JSON.stringify(preset.building);
      const copy = createTemplate(
        preset.building,
        "My emergency setup",
        preset.id,
      );
      copy.building.spawn_zones[0]!.name = "Edited occupants";
      expect(JSON.stringify(preset.building)).toBe(before);
      expect(buildingError(copy.building)).toBeNull();
      expect(copy.building.disaster).toEqual(preset.building.disaster);
    },
  );

  it("uses the new corporate plan as the fire scenario's editable, hazard-free counterpart", () => {
    const office = buildingPresets.find(
      (p) => p.id === "corporate-office",
    )!.building;
    const clear = structuredClone(emergencyPresets[0].building);
    delete clear.disaster;
    expect(clear).toEqual(office);
    expect(office.disaster).toBeUndefined();
    expect(office.exits).toHaveLength(3);
    expect(office.windows!.length).toBeGreaterThan(0);
    expect(office.stair_areas).toHaveLength(1);
  });

  it("configures existing fire, shelter and gas systems and reuses the actual school", () => {
    expect(emergencyPresets.map((p) => p.building.disaster?.kind)).toEqual([
      "fire",
      "tornado",
      "gas_leak",
      undefined,
    ]);
    expect(emergencyPresets[0].building.exits.length).toBeGreaterThan(1);
    expect(emergencyPresets[1].building.tornado_zones).toHaveLength(2);
    expect(emergencyPresets[3].building).toBe(
      buildingPresets.find((p) => p.id === "school-emergency")!.building,
    );
    expect(
      emergencyPresets[3].building.windows?.every(
        (w) => w.emergency_escape?.enabled,
      ),
    ).toBe(true);
    expect(
      emergencyPresets[3].building.obstructions.filter((o) =>
        o.id.startsWith("school-a-door-cabinet-"),
      ),
    ).toHaveLength(2);
  });
});
