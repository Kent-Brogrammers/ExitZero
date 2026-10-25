import type { ReplayTarget } from "../simulation/replayTarget";
import type { LayoutSaveActions } from "../templates/layouts";
import { useEffect, useState, type Ref } from "react";
import type {
  BuildingScenario,
  LiveSimulation,
  LiveSpeedControl,
  SimulationResult,
  ScenarioReplay,
} from "../types/simulation";
import { SimulationView } from "../simulation/SimulationView";
import { BuildingEditor, type BuildingEditorHandle } from "./BuildingEditor";
import "./BuildingWorkspace.css";

type Mode = "edit" | "simulation";

interface BuildingWorkspaceProps {
  building: BuildingScenario;
  onChange: (building: BuildingScenario) => void;
  result: SimulationResult | null;
  live?: LiveSimulation | null;
  replayTarget?: ReplayTarget | null;
  disabled?: boolean;
  savedLayoutJson?: string;
  onSaved?: (building: BuildingScenario, reason?: "export" | "replace") => void;
  saveActions?: LayoutSaveActions;
  mode?: Mode;
  active?: boolean;
  allowSyntheticPreview?: boolean;
  onOpenAnalytics?: () => void;
  onLiveSpeedChange?: (speed: LiveSpeedControl["speed"]) => void;
  onCancelLive?: () => void;
  editorRef?: Ref<BuildingEditorHandle>;
  scenarioReplay?: ScenarioReplay | null;
  onReturnFromScenario?: () => void;
  comparisonReplay?: {
    building: BuildingScenario;
    result: SimulationResult;
  } | null;
}

export function BuildingWorkspace({
  building,
  onChange,
  result,
  live,
  disabled,
  savedLayoutJson,
  onSaved,
  mode: controlledMode,
  active = true,
  allowSyntheticPreview = true,
  onOpenAnalytics,
  replayTarget,
  onLiveSpeedChange,
  onCancelLive,
  saveActions,
  editorRef,
  scenarioReplay,
  onReturnFromScenario,
  comparisonReplay,
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
          editorRef={editorRef}
          building={building}
          onChange={onChange}
          disabled={disabled}
          savedLayoutJson={savedLayoutJson}
          onSaved={onSaved}
          saveActions={saveActions}
        />
      </div>
      <div
        className={`workspace-view${scenarioReplay || comparisonReplay ? " has-scenario-replay" : ""}`}
        id="workspace-simulation-panel"
        role="tabpanel"
        aria-labelledby="studio-simulation-tab"
        hidden={mode !== "simulation"}
      >
        {(scenarioReplay || comparisonReplay) && (
          <div className="scenario-replay-context">
            <span>
              {scenarioReplay
                ? `Tested scenario: ${scenarioReplay.scenario_id}`
                : "Original comparison recording"}{" "}
              · editable layout unchanged
            </span>
            <button className="studio-control" onClick={onReturnFromScenario}>
              Return to comparison / baseline
            </button>
          </div>
        )}
        <SimulationView
          building={
            comparisonReplay?.building ?? scenarioReplay?.building ?? building
          }
          result={comparisonReplay?.result ?? scenarioReplay?.result ?? result}
          live={live}
          onLiveSpeedChange={onLiveSpeedChange}
          onCancelLive={onCancelLive}
          replayTarget={replayTarget}
          allowSyntheticPreview={
            allowSyntheticPreview && !scenarioReplay && !comparisonReplay
          }
          active={active && mode === "simulation"}
          onOpenAnalytics={onOpenAnalytics}
        />
      </div>
    </section>
  );
}
