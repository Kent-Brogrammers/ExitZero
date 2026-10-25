import officeFire from "./presets/office-fire.json";
import communityTornado from "./presets/community-tornado.json";
import laboratoryGas from "./presets/laboratory-gas.json";
import school from "./presets/school-emergency.json";
import type { BuildingScenario } from "../types/simulation";

/** Editable inputs only. Every Run uses the ordinary Rust simulation endpoint. */
export const emergencyPresets = [
  {
    id: "office-fire",
    label: "Office Fire Test",
    description:
      "A growing fire closes the east passage. Crowded office corridors lead to lobby and west-exit alternatives.",
    building: officeFire as BuildingScenario,
  },
  {
    id: "community-tornado",
    label: "Community Center Tornado Test",
    description:
      "A moving tornado crosses the assembly hall. Two narrow refuge entrances constrain the crowd.",
    building: communityTornado as BuildingScenario,
  },
  {
    id: "laboratory-gas",
    label: "Laboratory Gas Leak Test",
    description:
      "Expanding gas patches pressure the upper bypass and lab doors. Support rooms and a lower corridor offer escape routes.",
    building: laboratoryGas as BuildingScenario,
  },
  {
    id: "school-window",
    label: "School Window Escape Test",
    description:
      "Cabinets obstruct Classroom A’s door route. Ground-floor escape windows are enabled.",
    building: school as BuildingScenario,
  },
] as const;
