import house from "./presets/house.json";
import classroom from "./presets/classroom.json";
import office from "./presets/office.json";
import type { BuildingScenario } from "../types/simulation";
export const buildingPresets = [
  { id: "house", label: "Small house", building: house as BuildingScenario },
  {
    id: "classroom",
    label: "Classroom",
    building: classroom as BuildingScenario,
  },
  { id: "office", label: "Office", building: office as BuildingScenario },
] as const;
export type BuildingPreset = (typeof buildingPresets)[number];
