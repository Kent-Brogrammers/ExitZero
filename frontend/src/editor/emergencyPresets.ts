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
      "Fire affects the west exit; an alternative route leads to the east exit.",
    building: officeFire as BuildingScenario,
  },
  {
    id: "community-tornado",
    label: "Community Center Tornado Test",
    description:
      "A gathering hall with two interior refuges for tornado sheltering.",
    building: communityTornado as BuildingScenario,
  },
  {
    id: "laboratory-gas",
    label: "Laboratory Gas Leak Test",
    description:
      "Gas affects the upper corridor; a lower corridor remains available.",
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
