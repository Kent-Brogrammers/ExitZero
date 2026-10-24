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
}

export function BuildingWorkspace({
  building,
  onChange,
  result,
  disabled,
}: BuildingWorkspaceProps) {
  const [mode, setMode] = useState<Mode>(() =>
    typeof window !== "undefined" && window.location.hash === "#simulation"
      ? "simulation"
      : "edit",
  );
  useEffect(() => {
    const followHash = () => {
      if (window.location.hash === "#building") setMode("edit");
      if (window.location.hash === "#simulation") setMode("simulation");
    };
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
  }, []);
  useEffect(() => {
    if (result) setMode("simulation");
  }, [result]);

  function changeMode(next: Mode, focusTab = false) {
    setMode(next);
    window.history.replaceState(
      window.history.state,
      "",
      next === "edit" ? "#building" : "#simulation",
    );
    if (focusTab) document.getElementById(`workspace-${next}-tab`)?.focus();
  }

  return (
    <section
      className="workspace-shell"
      id="workspace"
      aria-label="Building workspace"
    >
      <div className="workspace-topbar">
        <div className="workspace-title">
          <span className="workspace-mark" aria-hidden="true">
            ↗
          </span>
          <h2>{mode === "edit" ? "Floor plan" : "Simulation playback"}</h2>
          <span className="workspace-subtitle">Continuous 2D</span>
        </div>
        <div
          className="workspace-modes"
          role="tablist"
          aria-label="Workspace mode"
          onKeyDown={(event) => {
            if (
              ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
            ) {
              event.preventDefault();
              changeMode(
                event.key === "Home"
                  ? "edit"
                  : event.key === "End"
                    ? "simulation"
                    : mode === "edit"
                      ? "simulation"
                      : "edit",
                true,
              );
            }
          }}
        >
          {(
            [
              ["edit", "Edit"],
              ["simulation", "Simulation"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              id={`workspace-${value}-tab`}
              type="button"
              role="tab"
              aria-selected={mode === value}
              aria-controls={`workspace-${value}-panel`}
              tabIndex={mode === value ? 0 : -1}
              onClick={() => changeMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <a className="workspace-analytics-link" href="#analytics">
          View analytics <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div
        className="workspace-view"
        id="workspace-edit-panel"
        role="tabpanel"
        aria-labelledby="workspace-edit-tab"
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
        aria-labelledby="workspace-simulation-tab"
        hidden={mode !== "simulation"}
      >
        <SimulationView
          building={building}
          result={result}
          active={mode === "simulation"}
        />
      </div>
    </section>
  );
}
