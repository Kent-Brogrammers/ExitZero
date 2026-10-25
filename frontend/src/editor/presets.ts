import house from "./presets/house.json";
import classroom from "./presets/classroom.json";
import office from "./presets/office.json";
import officeDemo from "./presets/office-demo.json";
import schoolEmergency from "./presets/school-emergency.json";
import corporateOffice from "./presets/corporate-office.json";
import type { BuildingScenario } from "../types/simulation";
export const buildingPresets = [
  { id: "house", label: "Small house", building: house as BuildingScenario },
  {
    id: "classroom",
    label: "Classroom",
    building: classroom as BuildingScenario,
  },
  { id: "office", label: "Office", building: office as BuildingScenario },
  {
    id: "office-demo",
    label: "Office demo",
    building: officeDemo as BuildingScenario,
  },
  {
    id: "school-emergency",
    label: "School — Emergency Scenarios",
    building: schoolEmergency as BuildingScenario,
  },
  {
    id: "corporate-office",
    label: "Corporate Office",
    building: corporateOffice as BuildingScenario,
  },
] as const;
export type BuildingPreset = (typeof buildingPresets)[number];
