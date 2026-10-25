export interface SimulationDisplayOptions {
  hazardMode: "filled" | "outline" | "both";
  showBlockedLabels: boolean;
  showTraffic: boolean;
}
export const defaultDisplayOptions: SimulationDisplayOptions = {
  hazardMode: "filled",
  showBlockedLabels: false,
  showTraffic: true,
};
