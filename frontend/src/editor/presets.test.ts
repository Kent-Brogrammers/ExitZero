import { describe, it, expect } from "vitest";
import { buildingPresets, halloweenPreset } from "./presets";
import { buildingError, removeElement } from "./geometry";
import {
  createTemplate,
  readTemplates,
  writeTemplates,
} from "../templates/templates";
import school from "./presets/school-emergency.json";
import type { BuildingScenario } from "../types/simulation";
describe("editable building presets", () => {
  it.each([...buildingPresets, halloweenPreset])(
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

  it("keeps the school editable without any configured opening closures", () => {
    const preset = buildingPresets.find((p) => p.id === "school-emergency")!;
    expect(preset.label).toBe("School — Emergency Scenarios");
    expect(preset.building).toEqual(school);
    expect(school.blocked_exit_ids).toEqual([]);
    expect(preset.building.opening_events ?? []).toEqual([]);
    expect(school.windows).toHaveLength(4);
    expect(school.windows.every((w) => w.emergency_escape.enabled)).toBe(true);
    expect(school.tornado_zones).toHaveLength(2);
    for (const [index, a] of school.obstructions.entries()) {
      for (const b of school.obstructions.slice(index + 1))
        expect(
          a.x < b.x + b.width &&
            b.x < a.x + a.width &&
            a.y < b.y + b.height &&
            b.y < a.y + a.height,
          `${a.id} overlaps ${b.id}`,
        ).toBe(false);
    }
    for (const room of ["a", "b", "c", "d"]) {
      expect(
        school.spawn_zones.some((z) => z.id === `school-${room}-students`),
      ).toBe(true);
      expect(
        school.spawn_zones.some((z) => z.id === `school-${room}-teacher`),
      ).toBe(true);
    }
    const storage = {
      value: "",
      getItem() {
        return this.value || null;
      },
      setItem(_key: string, value: string) {
        this.value = value;
      },
    };
    writeTemplates(storage, [
      createTemplate(preset.building, "My school", "school-copy"),
    ]);
    expect(readTemplates(storage)[0]!.building).toEqual(school);
    let edited: BuildingScenario = structuredClone(preset.building);
    for (const id of ["school-a-door-cabinet-1", "school-a-door-cabinet-2"])
      edited = removeElement(edited, { kind: "obstructions", id });
    expect(buildingError(edited)).toBeNull();
    expect(edited.obstructions.length).toBe(school.obstructions.length - 2);
    expect(preset.building).toEqual(school);
  });

  it("retains valid interior shelter zones when switching the school to tornado response", () => {
    expect(
      buildingError({
        ...school,
        disaster: { kind: "tornado", center: { x: 1, y: 13 }, radius: 0.4 },
      }),
    ).toBeNull();
  });
});
