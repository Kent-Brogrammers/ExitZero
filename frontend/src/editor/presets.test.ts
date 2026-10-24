import { describe, it, expect } from "vitest";
import { buildingPresets } from "./presets";
import { buildingError } from "./geometry";
describe("editable building presets", () => {
  it.each(buildingPresets)(
    "validates $label as a complete metre-coordinate building",
    (preset) => {
      expect(buildingError(preset.building)).toBeNull();
      expect(JSON.parse(JSON.stringify(preset.building))).toEqual(
        preset.building,
      );
      expect(
        preset.building.spawn_zones.reduce((n, z) => n + z.count, 0),
      ).toBeGreaterThan(0);
      expect(preset.building.exits.length).toBeGreaterThan(0);
      expect(preset.building.doors.length).toBeGreaterThan(0);
      expect("frames" in preset.building).toBe(false);
    },
  );
});
