import { useEffect, useState } from "react";
import type { BuildingScenario, SimulationResult } from "../types/simulation";
import { SimulationView } from "../simulation/SimulationView";
import { BuildingEditor } from "./BuildingEditor";
import "./BuildingWorkspace.css";

type Mode = "edit" | "simulation";

interface BuildingWorkspaceProps {
  building: BuildingScenario;
  onChange: (building: BuildingScenario) => void;
  result: SimulationResult | null;
  disabled?: boolean;
  mode?: Mode;
  active?: boolean;
}

export function BuildingWorkspace({
  building,
  onChange,
  result,
  disabled,
  mode: controlledMode,
  active = true,
}: BuildingWorkspaceProps) {
  const [localMode, setMode] = useState<Mode>(() =>
    typeof window !== "undefined" && window.location.hash === "#simulation"
      ? "simulation"
      : "edit",
  );
  const mode = controlledMode ?? localMode;
  useEffect(() => {
    if (controlledMode !== undefined) return;
    const followHash = () => {
      if (window.location.hash === "#building") setMode("edit");
      if (window.location.hash === "#simulation") setMode("simulation");
    };
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
  }, [controlledMode]);
  useEffect(() => {
    if (result && controlledMode === undefined) setMode("simulation");
  }, [result, controlledMode]);

  return (
    <section
      className="workspace-shell"
      id="workspace"
      aria-label="Building workspace"
    >
      <div
        className="workspace-view"
        id="workspace-edit-panel"
        role="tabpanel"
        aria-labelledby="studio-edit-tab"
        hidden={mode !== "edit"}
      >
        <BuildingEditor
          building={building}
          onChange={onChange}
          disabled={disabled}
        />
      </div>
      <div
        className="workspace-view"
        id="workspace-simulation-panel"
        role="tabpanel"
        aria-labelledby="studio-simulation-tab"
        hidden={mode !== "simulation"}
      >
        <SimulationView
          building={building}
          result={result}
          active={active && mode === "simulation"}
        />
      </div>
    </section>
  );
}
