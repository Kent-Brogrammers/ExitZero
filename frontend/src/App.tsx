import halloweenPreset from "./editor/presets/halloween-pursuit.json";
import { LengthInput } from "./ui/LengthInput";
import { formatDimensions } from "./utils/units";
import type { ReplayTarget } from "./simulation/replayTarget";
import { appendChat } from "./simulation/communication";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import example from "../../shared/examples/building.json";
import defaultOffice from "./editor/presets/corporate-office.json";
import { withoutObjectNames } from "./editor/names";
import { buildingError } from "./editor/geometry";
import { BuildingWorkspace } from "./editor/BuildingWorkspace";
import type { BuildingEditorHandle } from "./editor/BuildingEditor";
import { StudioPopover } from "./ui/StudioPopover";
import { AppearanceSelector } from "./styles/StudioAppearance";
import { StudioWelcome } from "./studio/StudioWelcome";
import { StudioAbout } from "./studio/StudioAbout";
import { TemplatesPage } from "./templates/TemplatesPage";
import { LayoutNameDialog } from "./templates/LayoutNameDialog";
import { PursuitReport } from "./simulation/PursuitMetrics";
import { storeLayout } from "./templates/layouts";
import type { UserTemplate } from "./templates/templates";
import { loadOfficeDemo, officeDemoBuilding } from "./studio/officeDemo";
import {
  OfficeDemoNotice,
  type OfficeDemoSource,
} from "./studio/OfficeDemoNotice";
import { api } from "./services/api";
import { ComputationJobs } from "./services/ComputationJobs";
import { jobLabel } from "./services/jobPresentation";
import type { BaselineRecording } from "./analytics/comparison";
import {
  applyOptimizationCandidate,
  type OptimizationEvaluation,
} from "./analytics/optimization";
import type {
  BuildingScenario,
  LiveSimulation,
  SimulationResult,
  StressTestResult,
  OptimizationCandidate,
  LiveSpeedControl,
  JobSnapshot,
  OptimizationResult,
  ScenarioReplay,
} from "./types/simulation";

const AnalyticsDashboard = lazy(() => import("./analytics/AnalyticsDashboard"));

type StudioView = "welcome" | "templates" | "edit" | "simulation" | "analytics";
const studioViews = [
  ["templates", "Templates"],
  ["edit", "Edit"],
  ["simulation", "Simulation"],
  ["analytics", "Analytics"],
] as const;
function viewFromHash(): StudioView {
  if (window.location.hash === "#templates") return "templates";
  if (window.location.hash === "#building") return "edit";
  if (window.location.hash === "#simulation") return "simulation";
  if (window.location.hash === "#analytics") return "analytics";
  return "welcome";
}

export default function App() {
  const [view, setView] = useState<StudioView>(viewFromHash);
  function navigate(next: StudioView, focus = false) {
    setView(next);
    window.history.replaceState(
      window.history.state,
      "",
      next === "edit" ? "#building" : `#${next}`,
    );
    if (focus) document.getElementById(`studio-${next}-tab`)?.focus();
  }
  useEffect(() => {
    const followHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
  }, []);

  const [building, setBuilding] = useState<BuildingScenario>(() =>
    structuredClone(defaultOffice as BuildingScenario),
  );
  const [halloweenMusic, setHalloweenMusic] = useState(false);
  const layoutProblem = buildingError(building);
  const [savedLayoutJson, setSavedLayoutJson] = useState(() =>
    JSON.stringify(building),
  );
  const [layoutRevision, setLayoutRevision] = useState(0);
  const editor = useRef<BuildingEditorHandle | null>(null);
  const [activeLayout, setActiveLayout] = useState<UserTemplate | null>(null);
  const [saveMode, setSaveMode] = useState<
    "save" | "saveAs" | "template" | null
  >(null);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const dirty = JSON.stringify(building) !== savedLayoutJson;
  function markSaved(next: BuildingScenario, reason?: "export" | "replace") {
    if (reason === "replace") setActiveLayout(null);
    // A JSON backup does not update the opened browser copy.
    if (reason === "export" && activeLayout) return;
    setSavedLayoutJson(JSON.stringify(next));
  }
  function saveNamed(name: string, mode: "save" | "saveAs" | "template") {
    const entry = storeLayout(
      window.localStorage,
      building,
      name,
      mode === "template" ? "template" : "layout",
      mode === "save" ? (activeLayout ?? undefined) : undefined,
    );
    if (mode !== "template") {
      setActiveLayout(entry);
      markSaved(building);
    }
    setLibraryRevision((revision) => revision + 1);
    setMessage(
      mode === "template"
        ? `“${entry.name}” added to My Templates.`
        : `“${entry.name}” saved in this browser.`,
    );
  }
  function save() {
    if (busy || buildingError(building, false)) return;
    if (!activeLayout) {
      setSaveMode("save");
      return;
    }
    try {
      saveNamed(activeLayout.name, "save");
    } catch (error) {
      setMessage(
        `${error instanceof Error ? error.message : "Could not save in this browser."} Use Save As or export JSON to keep a backup.`,
      );
    }
  }
  const saveActions = {
    save,
    saveAs: () => setSaveMode("saveAs"),
    saveTemplate: () => setSaveMode("template"),
    open: () => {
      navigate("templates");
      requestAnimationFrame(() =>
        document.getElementById("saved-layouts")?.scrollIntoView(),
      );
    },
  };
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function canReplace(name: string) {
    return (
      JSON.stringify(building) === savedLayoutJson ||
      window.confirm(
        `Replace your unsaved layout with ${name}? Save it in My Templates or export JSON first to keep a copy.`,
      )
    );
  }
  function loadTemplate(
    next: BuildingScenario,
    name: string,
    action: "edit" | "simulate",
    source?: UserTemplate,
  ) {
    if (busy || !canReplace(name)) return;
    // Pass this same independent copy to run(), without waiting for React state.
    setHalloweenMusic(!source && next === halloweenPreset);
    const selected = structuredClone(next);
    setBuilding(selected);
    setBaseline(null);
    setActiveLayout(source?.kind === "layout" ? structuredClone(source) : null);
    markSaved(selected);
    setResult(null);
    setStressResult(null);
    setStressJobId(null);
    setScenarioReplay(null);
    setViewOriginal(false);
    setOptimization(null);
    setReplayTarget(null);
    setOfficeDemo(null);
    setLive(null);
    previousWorkspace.current = null;
    setLayoutRevision((revision) => revision + 1);
    setMessage("");
    if (action === "edit") navigate("edit");
    else void run("simulate", selected);
  }
  function changeBuilding(next: BuildingScenario) {
    const namesOnly =
      JSON.stringify(withoutObjectNames(building)) ===
      JSON.stringify(withoutObjectNames(next));
    setBuilding(next);
    if (namesOnly) return;
    setLive(null);
    if (result && !baseline)
      setBaseline({
        building: structuredClone(building),
        result,
        source: officeDemo === "recorded" ? "recorded_demo" : "computed",
      });
    setResult(null);
    setStressResult(null);
    setStressJobId(null);
    setScenarioReplay(null);
    setViewOriginal(false);
    setOptimization(null);
    if (officeDemo) setOfficeDemo("edited");
    setMessage("");
  }
  const [connection, setConnection] = useState<
    "checking" | "online" | "offline"
  >("checking");
  const [healthAttempt, setHealthAttempt] = useState(0);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [baseline, setBaseline] = useState<BaselineRecording | null>(null);
  const [viewOriginal, setViewOriginal] = useState(false);
  const [replayTarget, setReplayTarget] = useState<ReplayTarget | null>(null);
  const [live, setLive] = useState<LiveSimulation | null>(null);
  const soundtrack = useRef<HTMLAudioElement>(null);
  const soundtrackRunning =
    halloweenMusic &&
    !!building.pursuit &&
    view === "simulation" &&
    live !== null &&
    busy;
  useEffect(() => {
    const audio = soundtrack.current;
    return () => {
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
    };
  }, [soundtrackRunning]);
  const liveRequest = useRef<AbortController | null>(null);
  const liveRunId = useRef<string | null>(null);
  function cancelLive() {
    if (!liveRequest.current || liveRequest.current.signal.aborted) return;
    liveRequest.current.abort();
    setLive((previous) =>
      previous
        ? {
            ...previous,
            status: "cancelled",
            speed_pending: false,
            control_error: undefined,
          }
        : previous,
    );
    setMessage("Simulation cancelled.");
  }
  async function changeLiveSpeed(speed: LiveSpeedControl["speed"]) {
    const controller = liveRequest.current;
    const id = liveRunId.current;
    if (!controller || controller.signal.aborted || !id || live?.speed_pending)
      return;
    setLive((previous) =>
      previous
        ? { ...previous, speed_pending: true, control_error: undefined }
        : previous,
    );
    try {
      const applied = await api.setLiveSpeed(id, speed, controller.signal);
      if (liveRequest.current === controller && !controller.signal.aborted)
        setLive((previous) =>
          previous ? { ...previous, speed: applied.speed } : previous,
        );
    } catch (error) {
      if (liveRequest.current === controller && !controller.signal.aborted)
        setLive((previous) =>
          previous
            ? {
                ...previous,
                control_error:
                  error instanceof Error
                    ? error.message
                    : "Could not change speed.",
              }
            : previous,
        );
    } finally {
      if (liveRequest.current === controller)
        setLive((previous) =>
          previous ? { ...previous, speed_pending: false } : previous,
        );
    }
  }
  const computationId = useRef<string | null>(null);
  const stopRequested = useRef(false);
  const background = useRef(false);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [stressJobId, setStressJobId] = useState<string | null>(null);
  const [scenarioReplay, setScenarioReplay] = useState<ScenarioReplay | null>(
    null,
  );
  const [operation, setOperation] = useState<
    "simulate" | "calculate" | "stress" | "optimize" | "watch" | null
  >(null);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const abandon = () => {
      const id = computationId.current;
      if (id && !background.current)
        void api.cancelComputation(id).catch(() => undefined);
      liveRequest.current?.abort();
    };
    window.addEventListener("pagehide", abandon);
    return () => {
      window.removeEventListener("pagehide", abandon);
      abandon();
    };
  }, []);
  const [stressResult, setStressResult] = useState<StressTestResult | null>(
    null,
  );
  const [optimization, setOptimization] =
    useState<OptimizationEvaluation | null>(null);

  function applyCandidate(candidate: OptimizationCandidate) {
    if (!optimization || busy) return;
    try {
      const next = applyOptimizationCandidate(
        building,
        optimization.result.baseline,
        candidate,
      );
      if (!editor.current?.applyBuilding(next)) return;
      setResult(null);
      setStressResult(null);
      setStressJobId(null);
      setScenarioReplay(null);
      setViewOriginal(false);
      setOptimization({ ...optimization, applied: candidate });
      if (officeDemo) setOfficeDemo("edited");
      setMessage(
        "Candidate applied. Run simulation to measure the new layout.",
      );
      navigate("edit");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not apply candidate.",
      );
    }
  }

  const [officeDemo, setOfficeDemo] = useState<OfficeDemoSource | null>(null);
  const previousWorkspace = useRef<{
    building: BuildingScenario;
    result: SimulationResult | null;
    stressResult: StressTestResult | null;
    optimization: OptimizationEvaluation | null;
    savedLayoutJson: string;
    baseline: BaselineRecording | null;
    stressJobId: string | null;
    activeLayout: UserTemplate | null;
  } | null>(null);

  async function openOfficeDemo() {
    if (busy) return;
    if (!canReplace("the saved office demo")) return;
    setBusy(true);
    setLive(null);
    try {
      const recording = await loadOfficeDemo();
      previousWorkspace.current ??= {
        building,
        result,
        stressResult,
        optimization,
        savedLayoutJson,
        baseline,
        stressJobId,
        activeLayout,
      };
      setBuilding(structuredClone(officeDemoBuilding));
      setBaseline(null);
      markSaved(officeDemoBuilding);
      setActiveLayout(null);
      setLayoutRevision((revision) => revision + 1);
      setReplayTarget(null);
      setResult(recording);
      setStressResult(null);
      setStressJobId(null);
      setScenarioReplay(null);
      setViewOriginal(false);
      setOptimization(null);
      setOfficeDemo("recorded");
      setMessage("");
      navigate("simulation");
    } catch {
      setMessage(
        "The office demo could not be loaded. Your layout is unchanged; try opening it again.",
      );
      navigate("edit");
    } finally {
      setBusy(false);
    }
  }
  function returnFromOfficeDemo() {
    const previous = previousWorkspace.current;
    if (busy || !previous) return;
    if (!canReplace("your previous layout")) return;
    setBuilding(previous.building);
    setResult(previous.result);
    setStressResult(previous.stressResult);
    setOptimization(previous.optimization);
    setBaseline(previous.baseline);
    setStressJobId(previous.stressJobId);
    setScenarioReplay(null);
    setViewOriginal(false);
    setSavedLayoutJson(previous.savedLayoutJson);
    setActiveLayout(previous.activeLayout);
    setLayoutRevision((revision) => revision + 1);
    setReplayTarget(null);
    setLive(null);
    previousWorkspace.current = null;
    setOfficeDemo(null);
    setMessage("");
    navigate("edit");
  }

  useEffect(() => {
    const controller = new AbortController();
    api
      .health(controller.signal)
      .then(() => setConnection("online"))
      .catch(() => {
        if (!controller.signal.aborted) setConnection("offline");
      });
    return () => controller.abort();
  }, [healthAttempt]);

  async function run(
    action: "simulate" | "calculate" | "stress" | "optimize" | "watch",
    scenario = building,
    scenarioId?: string,
  ) {
    if (busy || (action === "watch" && (!stressJobId || !scenarioId))) return;
    if (
      scenario.pursuit &&
      (action === "stress" || action === "optimize" || action === "watch")
    ) {
      setMessage(
        "Safety stress testing and optimization apply to ordinary evacuation modes.",
      );
      return;
    }
    setBusy(true);
    setLive(null);
    setMessage("Sending request…");
    const controller = new AbortController();
    const id = crypto.randomUUID();
    computationId.current = id;
    liveRequest.current = controller;
    stopRequested.current = false;
    background.current = action !== "simulate";
    setJob(null);
    setOperation(action);
    setStopping(false);
    setMessage(
      `${action === "stress" ? "Stress testing" : action === "optimize" ? "Optimization" : "Simulation"} requested. Waiting for computation…`,
    );
    function acceptCompletion() {
      if (stopRequested.current) controller.abort();
      controller.signal.throwIfAborted();
    }
    const updateJob = (next: JobSnapshot) => {
      if (controller.signal.aborted) return;
      setJob(next);
      if (next.kind === "stress") setStressJobId(next.id);
      computationId.current = next.id;
      if (!stopRequested.current) setMessage(jobLabel(next));
    };
    try {
      if (action === "simulate") {
        setScenarioReplay(null);
        setViewOriginal(false);
        if (officeDemo && scenario === building) setOfficeDemo("live");
        setResult(null);
        setStressResult(null);
        setStressJobId(null);
        setScenarioReplay(null);
        setViewOriginal(false);
        setReplayTarget(null);
        liveRunId.current = id;
        setLive({
          frame: null,
          chat: { messages: [], total: 0 },
          status: "running",
          speed: 1,
        });
        setMessage("Starting live simulation…");
        navigate("simulation");
        const recording = await api.simulateLive(
          scenario,
          (frame) => {
            if (!controller.signal.aborted) {
              setLive((previous) => ({ ...previous, frame }));
              setMessage("");
            }
          },
          controller.signal,
          (chat) => {
            if (controller.signal.aborted) return;
            const incoming = [
              ...chat.communication_events,
              ...chat.agent_events,
            ].sort((a, b) => a.step - b.step);
            setLive((previous) =>
              previous
                ? {
                    ...previous,
                    chat: appendChat(
                      previous.chat,
                      incoming,
                      scenario.time_step_seconds,
                    ),
                  }
                : previous,
            );
          },
          id,
        );
        acceptCompletion();
        setResult(recording);
        setMessage("Recording ready.");
      } else if (action === "calculate") {
        const recording = await api.simulate(
          scenario,
          controller.signal,
          id,
          updateJob,
        );
        acceptCompletion();
        setScenarioReplay(null);
        setViewOriginal(false);
        setResult(recording);
        setReplayTarget((previous) => ({
          source: recording,
          step: recording.frames[0]?.step ?? 0,
          request: (previous?.request ?? 0) + 1,
        }));
        navigate("analytics");
        setMessage(
          "Calculation ready. Open playback to watch the recorded run.",
        );
      } else if (action === "stress") {
        const stressed = await api.stressTest(
          {
            building: scenario,
            config: {
              max_scenarios: 10,
              block_each_exit: true,
              obstruction_candidates: [],
            },
          },
          controller.signal,
          id,
          updateJob,
        );
        acceptCompletion();
        setStressResult(stressed);
        setMessage("Stress test ready.");
      } else if (action === "watch") {
        const replay = await api.recordScenario(
          stressJobId!,
          scenarioId!,
          controller.signal,
          id,
          updateJob,
        );
        acceptCompletion();
        setScenarioReplay(replay);
        setViewOriginal(false);
        setReplayTarget((previous) => ({
          source: replay.result,
          step: replay.result.frames[0]?.step ?? 0,
          request: (previous?.request ?? 0) + 1,
          play: true,
        }));
        navigate("simulation");
        setMessage(
          "Recorded the selected stress scenario. The editable building and baseline recording are unchanged.",
        );
      } else {
        const optimized = await api.optimize(
          {
            building: scenario,
            max_candidates: 10,
          },
          controller.signal,
          id,
          updateJob,
        );
        acceptCompletion();
        setOptimization({
          source: structuredClone(scenario),
          result: optimized,
          applied: null,
        });
        setMessage(`${optimized.candidates.length} layout improvements found.`);
      }
    } catch (error) {
      setMessage(
        controller.signal.aborted || stopRequested.current
          ? action === "simulate"
            ? "Simulation stopped. No recording was saved."
            : "Computation stopped. Previous results were preserved."
          : error instanceof Error
            ? error.message
            : "Request failed.",
      );
    } finally {
      if (!liveRequest.current?.signal.aborted) setLive(null);
      liveRequest.current = null;
      liveRunId.current = null;
      computationId.current = null;
      setOperation(null);
      setStopping(false);
      setBusy(false);
    }
  }

  async function openJob(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      const request = await api.jobRequest(id);
      if (request.kind === "replay") {
        const replay = (await api.jobResult(id, request)) as ScenarioReplay;
        setScenarioReplay(replay);
        setViewOriginal(false);
        setReplayTarget((previous) => ({
          source: replay.result,
          step: replay.result.frames[0]?.step ?? 0,
          request: (previous?.request ?? 0) + 1,
          play: true,
        }));
        navigate("simulation");
        setMessage(
          "Opened the tested scenario recording. Your editable building is unchanged.",
        );
        return;
      }
      const source =
        request.kind === "simulate"
          ? request.building
          : request.request.building;
      if (
        JSON.stringify(source) !== JSON.stringify(building) &&
        !canReplace("this computation's original layout")
      )
        return;
      const computed = await api.jobResult(id, request);
      if (JSON.stringify(source) !== JSON.stringify(building)) {
        setBuilding(structuredClone(source));
        setLayoutRevision((value) => value + 1);
        markSaved(source, "replace");
        setResult(null);
        setStressResult(null);
        setStressJobId(null);
        setScenarioReplay(null);
        setViewOriginal(false);
        setOptimization(null);
        setOfficeDemo(null);
      }
      if (request.kind === "simulate") {
        setResult(computed as SimulationResult);
        const recording = computed as SimulationResult;
        setReplayTarget((previous) => ({
          source: recording,
          step: recording.frames[0]?.step ?? 0,
          request: (previous?.request ?? 0) + 1,
        }));
      } else if (request.kind === "stress") {
        setStressResult(computed as StressTestResult);
        setStressJobId(id);
      } else
        setOptimization({
          source,
          result: computed as OptimizationResult,
          applied: null,
        });
      navigate("analytics");
      setMessage("Opened a completed computation without rerunning it.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not open results.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function stopComputation() {
    const id = computationId.current;
    const controller = liveRequest.current;
    if (!id || !controller || stopping) return;
    stopRequested.current = true;
    setStopping(true);
    setJob((previous) =>
      previous ? { ...previous, status: "cancelling" } : null,
    );
    setMessage("Cancelling computation…");
    try {
      await api.cancelComputation(id);
      if (!background.current) {
        controller.abort();
        setLive((previous) =>
          previous
            ? {
                ...previous,
                status: "cancelled",
                speed_pending: false,
                control_error: undefined,
              }
            : previous,
        );
      }
    } catch (error) {
      // Keep the request connected so a failed Stop cannot abandon batch work.
      if (computationId.current !== id) return;
      stopRequested.current = false;
      setStopping(false);
      setMessage(
        `Could not confirm cancellation. Retry Stop. ${error instanceof Error ? error.message : ""}`,
      );
    }
  }

  return (
    <div
      className={`workspace-app${view === "welcome" ? " is-welcome" : ""}`}
      data-halloween={building.pursuit ? "true" : undefined}
    >
      <div className="welcome-view" hidden={view !== "welcome"}>
        <StudioWelcome
          building={officeDemoBuilding}
          onOpenDemo={() => void openOfficeDemo()}
          disabled={busy}
          onOpen={() => navigate("edit")}
          onTemplates={() => navigate("templates")}
          onOpenTemplate={loadTemplate}
          online={connection === "online"}
          onLoadExample={() =>
            loadTemplate(example, "the example building", "edit")
          }
        />
      </div>
      <div className="studio-shell" hidden={view === "welcome"}>
        <header className="studio-header">
          <a
            className="studio-brand"
            href="#welcome"
            aria-label="ExitZero Studio home"
          >
            <span className="studio-symbol" aria-hidden="true">
              ↗
            </span>
            ExitZero <span>Studio</span>
          </a>
          <nav aria-label="Main navigation">
            <div
              className="studio-nav"
              role="tablist"
              aria-label="Workspace mode"
              onKeyDown={(event) => {
                const current = studioViews.findIndex(
                  ([value]) => value === view,
                );
                if (
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault();
                  const index =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? studioViews.length - 1
                        : (current +
                            (event.key === "ArrowLeft"
                              ? studioViews.length - 1
                              : 1)) %
                          studioViews.length;
                  navigate(studioViews[index]![0], true);
                }
              }}
            >
              {studioViews.map(([value, label]) => (
                <button
                  key={value}
                  id={`studio-${value}-tab`}
                  type="button"
                  role="tab"
                  aria-selected={view === value}
                  aria-controls={
                    value === "templates"
                      ? "studio-templates-panel"
                      : value === "analytics"
                        ? "studio-analytics-panel"
                        : `workspace-${value}-panel`
                  }
                  tabIndex={view === value ? 0 : -1}
                  onClick={() => navigate(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </nav>
          <div className="studio-header-actions">
            {(view === "edit" || view === "simulation") && (
              <div className="layout-save-controls">
                <button
                  type="button"
                  className="studio-control"
                  disabled={busy || !!buildingError(building, false)}
                  onClick={save}
                >
                  Save
                </button>
                <div
                  className="layout-save-indicator"
                  role="status"
                  aria-label="Layout save status"
                  data-dirty={dirty}
                  title={activeLayout?.name}
                >
                  <span>
                    {dirty
                      ? "Unsaved changes"
                      : activeLayout
                        ? "Saved"
                        : "Not saved locally"}
                  </span>
                  {activeLayout && (
                    <span className="layout-save-name">
                      {activeLayout.name}
                    </span>
                  )}
                </div>
              </div>
            )}
            <StudioPopover
              label="Settings"
              className="app-settings"
              indicator={
                <span
                  className={`connection-dot ${connection}`}
                  aria-hidden="true"
                />
              }
            >
              {(close) => (
                <div className="settings-content">
                  <div className="control-popover-heading">
                    <h3>Studio settings</h3>
                    <button
                      type="button"
                      className="studio-control studio-control--icon"
                      aria-label="Close Settings"
                      onClick={close}
                    >
                      ×
                    </button>
                  </div>
                  <AppearanceSelector />
                  <fieldset disabled={busy}>
                    <legend>Agent awareness</legend>
                    {(
                      [
                        ["sight_range_metres", "Sight range (ft)", 8],
                        [
                          "communication_range_metres",
                          "Communication range (ft)",
                          3,
                        ],
                      ] as const
                    ).map(([key, label, fallback]) => (
                      <label key={key}>
                        {label}
                        <LengthInput
                          min={0}
                          max={1000}
                          value={building.awareness?.[key] ?? fallback}
                          onValue={(value) => {
                            if (
                              !Number.isFinite(value) ||
                              value < 0 ||
                              value > 1000
                            )
                              return;
                            changeBuilding({
                              ...building,
                              awareness: {
                                sight_range_metres: 8,
                                communication_range_metres: 3,
                                ...building.awareness,
                                [key]: value,
                              },
                            });
                          }}
                        />
                      </label>
                    ))}
                    <p className="note">
                      Agents assume exits are open until they see or hear
                      otherwise. Walls block sight and communication. Set
                      communication to 0 to disable sharing.
                    </p>
                  </fieldset>
                  <dl className="settings-values">
                    <div>
                      <dt>Display units</dt>
                      <dd>Feet (ft)</dd>
                    </div>
                  </dl>
                  <p className="note">
                    Layout JSON and simulation coordinates stay in meters.
                  </p>
                  <div className="settings-connection" role="status">
                    <span>
                      <i
                        className={`connection-dot ${connection}`}
                        aria-hidden="true"
                      />{" "}
                      Backend {connection}
                    </span>
                    {connection === "offline" && (
                      <button
                        type="button"
                        className="studio-control"
                        onClick={() => {
                          setConnection("checking");
                          setHealthAttempt((attempt) => attempt + 1);
                        }}
                      >
                        Retry
                      </button>
                    )}
                  </div>
                  <p className="settings-layout">
                    {formatDimensions(building.width, building.height)} ·{" "}
                    {building.exits.length} exits ·{" "}
                    {building.spawn_zones.reduce(
                      (total, zone) => total + zone.count,
                      0,
                    )}{" "}
                    occupants
                  </p>
                  {layoutProblem && (
                    <p className="settings-warning">{layoutProblem}</p>
                  )}
                  <StudioAbout />
                </div>
              )}
            </StudioPopover>
            <StudioPopover
              label="Computations"
              className="computations-popover"
            >
              {(close) => (
                <ComputationJobs
                  current={job}
                  disabled={busy}
                  onOpen={(id) => {
                    void openJob(id);
                    close();
                  }}
                />
              )}
            </StudioPopover>
            {operation ? (
              <button
                type="button"
                className="run-action"
                disabled={stopping}
                onClick={() => void stopComputation()}
              >
                {stopping
                  ? "Cancelling…"
                  : operation === "simulate"
                    ? "Stop Simulation"
                    : operation === "watch"
                      ? "Stop Scenario Recording"
                      : operation === "calculate"
                        ? "Stop Calculation"
                        : operation === "stress"
                          ? "Stop Stress Test"
                          : "Stop Optimization"}
              </button>
            ) : (
              view !== "templates" && (
                <button
                  className="run-action"
                  disabled={busy || connection !== "online" || !!layoutProblem}
                  title={
                    layoutProblem ??
                    (connection !== "online"
                      ? "Backend unavailable. Open Settings to retry."
                      : "Run this floor plan through the simulation engine.")
                  }
                  onClick={() => void run("simulate")}
                >
                  {busy ? "Working…" : "Run Simulation"}
                  <span aria-hidden="true">↗</span>
                </button>
              )
            )}
            {!operation && view !== "templates" && (
              <button
                className="studio-control"
                disabled={busy || connection !== "online" || !!layoutProblem}
                onClick={() => void run("calculate")}
                title="Compute the recording without real-time playback pacing"
              >
                Calculate Results
              </button>
            )}
          </div>
        </header>
        <main className={`studio-main${officeDemo ? " has-office-demo" : ""}`}>
          {halloweenMusic &&
            building.pursuit &&
            !officeDemo &&
            view === "simulation" &&
            live !== null &&
            busy && (
              <section
                aria-label="Halloween pursuit soundtrack"
                className="halloween-soundtrack"
              >
                <span>Halloween — The Pursuit · Soundtrack</span>
                <audio
                  ref={soundtrack}
                  aria-label="Halloween soundtrack playback and volume"
                  src={`${import.meta.env.BASE_URL}audio/halloween-pursuit.mp3`}
                  controls
                  autoPlay
                  loop
                  preload="none"
                />
                <small>
                  Press Play if sound does not start. Use the speaker control to
                  mute.
                </small>
              </section>
            )}
          {view !== "templates" && <h1 className="sr-only">ExitZero Studio</h1>}
          {officeDemo && view !== "templates" && (
            <OfficeDemoNotice
              source={officeDemo}
              result={result}
              busy={busy}
              onEdit={() => navigate("edit")}
              onReturn={returnFromOfficeDemo}
            />
          )}
          <section
            id="studio-templates-panel"
            role="tabpanel"
            aria-labelledby="studio-templates-tab"
            hidden={view !== "templates"}
          >
            {view === "templates" && (
              <TemplatesPage
                key={libraryRevision}
                building={building}
                busy={busy}
                online={connection === "online"}
                onOpen={loadTemplate}
                onSaved={markSaved}
                onSaveLayout={() => setSaveMode("saveAs")}
                onSaveTemplate={() => setSaveMode("template")}
                onEntryChanged={(id, entry) => {
                  if (activeLayout?.id === id) setActiveLayout(entry);
                }}
                onOfficeRecording={() => void openOfficeDemo()}
              />
            )}
          </section>
          <div
            className="studio-viewport"
            hidden={view !== "edit" && view !== "simulation"}
          >
            <BuildingWorkspace
              key={layoutRevision}
              editorRef={editor}
              building={building}
              onChange={changeBuilding}
              result={result}
              live={live}
              onLiveSpeedChange={changeLiveSpeed}
              onCancelLive={cancelLive}
              replayTarget={replayTarget}
              scenarioReplay={scenarioReplay}
              comparisonReplay={viewOriginal ? baseline : null}
              onReturnFromScenario={() => {
                setScenarioReplay(null);
                setViewOriginal(false);
                navigate("analytics");
              }}
              allowSyntheticPreview={!officeDemo && !building.pursuit}
              disabled={busy}
              savedLayoutJson={savedLayoutJson}
              onSaved={markSaved}
              saveActions={saveActions}
              mode={view === "simulation" ? "simulation" : "edit"}
              active={view === "edit" || view === "simulation"}
              onOpenAnalytics={() => {
                navigate("analytics");
              }}
            />
          </div>
          <section
            className="analytics-workspace"
            id="studio-analytics-panel"
            role="tabpanel"
            aria-labelledby="studio-analytics-tab"
            hidden={view !== "analytics"}
          >
            <div className="analysis-heading">
              <div>
                <p className="eyebrow">ANALYTICS</p>
                <h2>Simulation results.</h2>
              </div>
              <div
                className="control-buttons"
                role="group"
                aria-label="Analysis actions"
              >
                <button
                  disabled={
                    busy ||
                    connection !== "online" ||
                    !!layoutProblem ||
                    !!building.pursuit
                  }
                  title={
                    building.pursuit
                      ? "Safety stress tests apply to ordinary evacuation modes."
                      : undefined
                  }
                  onClick={() => void run("stress")}
                >
                  Stress Test
                </button>
                <button
                  disabled={
                    busy ||
                    connection !== "online" ||
                    !!layoutProblem ||
                    !!building.pursuit
                  }
                  title={
                    building.pursuit
                      ? "Safety optimization applies to ordinary evacuation modes."
                      : undefined
                  }
                  onClick={() => void run("optimize")}
                >
                  Optimize
                </button>
              </div>
            </div>
            <Suspense fallback={<p role="status">Loading analytics…</p>}>
              {result?.frames.at(-1)?.pursuit ? (
                <PursuitReport
                  result={result}
                  onReplay={() => navigate("simulation")}
                />
              ) : (
                <AnalyticsDashboard
                  onViewInSimulation={(step) => {
                    if (
                      !result ||
                      busy ||
                      !result.frames.some((frame) => frame.step === step)
                    )
                      return;
                    setReplayTarget((previous) => ({
                      source: result,
                      step,
                      request: (previous?.request ?? 0) + 1,
                    }));
                    navigate("simulation");
                    setScenarioReplay(null);
                    setViewOriginal(false);
                  }}
                  result={result}
                  stressResult={stressResult}
                  building={building}
                  baseline={baseline}
                  onWatchOriginal={() => {
                    setScenarioReplay(null);
                    setViewOriginal(true);
                    if (baseline)
                      setReplayTarget((previous) => ({
                        source: baseline.result,
                        step: baseline.result.frames[0]?.step ?? 0,
                        request: (previous?.request ?? 0) + 1,
                        play: true,
                      }));
                    navigate("simulation");
                  }}
                  optimization={optimization}
                  onStress={
                    building.pursuit ? undefined : () => void run("stress")
                  }
                  onOptimize={
                    building.pursuit ? undefined : () => void run("optimize")
                  }
                  onWatchScenario={
                    stressJobId && !building.pursuit
                      ? (id) => void run("watch", building, id)
                      : undefined
                  }
                  onApply={applyCandidate}
                  disabled={busy}
                />
              )}
            </Suspense>
          </section>
        </main>
        {saveMode && (
          <LayoutNameDialog
            title={
              saveMode === "template"
                ? "Save as template"
                : saveMode === "saveAs"
                  ? "Save layout as"
                  : "Save layout"
            }
            initialName={
              activeLayout
                ? saveMode === "saveAs"
                  ? `${activeLayout.name.slice(0, 75)} copy`
                  : activeLayout.name
                : saveMode === "template"
                  ? "My template"
                  : "My layout"
            }
            action={saveMode === "template" ? "Save as Template" : "Save"}
            onConfirm={(name) => saveNamed(name, saveMode)}
            onClose={() => setSaveMode(null)}
          />
        )}
        {message && (
          <div className="studio-notice" role="status">
            <span>{message}</span>
            <button
              aria-label="Dismiss notification"
              onClick={() => setMessage("")}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
