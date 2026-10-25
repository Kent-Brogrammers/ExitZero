import { lazy, Suspense, useEffect, useRef, useState } from "react";
import example from "../../shared/examples/building.json";
import { withoutObjectNames } from "./editor/names";
import { buildingError } from "./editor/geometry";
import { BuildingWorkspace } from "./editor/BuildingWorkspace";
import { StudioPopover } from "./ui/StudioPopover";
import { AppearanceSelector } from "./styles/StudioAppearance";
import { StudioWelcome } from "./studio/StudioWelcome";
import { StudioAbout } from "./studio/StudioAbout";
import { loadOfficeDemo, officeDemoBuilding } from "./studio/officeDemo";
import {
  OfficeDemoNotice,
  type OfficeDemoSource,
} from "./studio/OfficeDemoNotice";
import { api } from "./services/api";
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
} from "./types/simulation";

const AnalyticsDashboard = lazy(() => import("./analytics/AnalyticsDashboard"));

type StudioView = "welcome" | "edit" | "simulation" | "analytics";
const studioViews = [
  ["edit", "Edit"],
  ["simulation", "Simulation"],
  ["analytics", "Analytics"],
] as const;
function viewFromHash(): StudioView {
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
    structuredClone(example),
  );
  const layoutProblem = buildingError(building);
  function changeBuilding(next: BuildingScenario) {
    const namesOnly =
      JSON.stringify(withoutObjectNames(building)) ===
      JSON.stringify(withoutObjectNames(next));
    setBuilding(next);
    if (namesOnly) return;
    setResult(null);
    setStressResult(null);
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
  const [live, setLive] = useState<LiveSimulation | null>(null);
  const liveRequest = useRef<AbortController | null>(null);
  useEffect(() => () => liveRequest.current?.abort(), []);
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
      setBuilding(next);
      setResult(null);
      setStressResult(null);
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
  } | null>(null);

  async function openOfficeDemo() {
    if (busy) return;
    if (
      officeDemo &&
      JSON.stringify(building) !== JSON.stringify(officeDemoBuilding) &&
      !window.confirm(
        "Reload the office demo? Export any demo edits first to keep them.",
      )
    )
      return;
    setBusy(true);
    try {
      const recording = await loadOfficeDemo();
      previousWorkspace.current ??= {
        building,
        result,
        stressResult,
        optimization,
      };
      setBuilding(structuredClone(officeDemoBuilding));
      setResult(recording);
      setStressResult(null);
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
    if (
      JSON.stringify(building) !== JSON.stringify(officeDemoBuilding) &&
      !window.confirm(
        "Return to your previous layout? Export any demo edits first to keep them.",
      )
    )
      return;
    setBuilding(previous.building);
    setResult(previous.result);
    setStressResult(previous.stressResult);
    setOptimization(previous.optimization);
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

  async function run(action: "simulate" | "stress" | "optimize") {
    if (busy) return;
    setBusy(true);
    setMessage("Sending request…");
    try {
      if (action === "simulate") {
        if (officeDemo) setOfficeDemo("live");
        const controller = new AbortController();
        liveRequest.current = controller;
        setResult(null);
        setStressResult(null);
        setLive({ frame: null });
        setMessage("Starting live simulation…");
        navigate("simulation");
        const recording = await api.simulateLive(
          building,
          (frame) => {
            if (!controller.signal.aborted) {
              setLive({ frame });
              setMessage("");
            }
          },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setResult(recording);
          setMessage("Recording ready.");
        }
      } else if (action === "stress") {
        setStressResult(
          await api.stressTest({
            building,
            config: {
              max_scenarios: 10,
              block_each_exit: true,
              obstruction_candidates: [],
            },
          }),
        );
        setMessage("Stress test ready.");
      } else {
        const optimized = await api.optimize({ building, max_candidates: 10 });
        setOptimization({
          source: structuredClone(building),
          result: optimized,
          applied: null,
        });
        setMessage(`${optimized.candidates.length} layout improvements found.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setLive(null);
      liveRequest.current = null;
      setBusy(false);
    }
  }

  return (
    <div className={`workspace-app${view === "welcome" ? " is-welcome" : ""}`}>
      <div className="welcome-view" hidden={view !== "welcome"}>
        <StudioWelcome
          building={officeDemoBuilding}
          onOpenDemo={() => void openOfficeDemo()}
          disabled={busy}
          onOpen={() => navigate("edit")}
          onLoadExample={() => {
            if (busy) return;
            changeBuilding(structuredClone(example));
            navigate("edit");
          }}
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
                        ? 2
                        : (current + (event.key === "ArrowLeft" ? 2 : 1)) % 3;
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
                    value === "analytics"
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
                        ["sight_range_metres", "Sight range (m)", 8],
                        [
                          "communication_range_metres",
                          "Communication range (m)",
                          3,
                        ],
                      ] as const
                    ).map(([key, label, fallback]) => (
                      <label key={key}>
                        {label}
                        <input
                          type="number"
                          min={0}
                          max={1000}
                          step={0.5}
                          value={building.awareness?.[key] ?? fallback}
                          onChange={(event) => {
                            const value = event.currentTarget.valueAsNumber;
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
                      <dt>Coordinates</dt>
                      <dd>Metres</dd>
                    </div>
                  </dl>
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
                    {building.width} × {building.height} m ·{" "}
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
          </div>
        </header>
        <main className={`studio-main${officeDemo ? " has-office-demo" : ""}`}>
          <h1 className="sr-only">ExitZero Studio</h1>
          {officeDemo && (
            <OfficeDemoNotice
              source={officeDemo}
              result={result}
              busy={busy}
              onEdit={() => navigate("edit")}
              onReturn={returnFromOfficeDemo}
            />
          )}
          <div className="studio-viewport" hidden={view === "analytics"}>
            <BuildingWorkspace
              building={building}
              onChange={changeBuilding}
              result={result}
              live={live}
              allowSyntheticPreview={!officeDemo}
              disabled={busy}
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
                  disabled={busy || connection !== "online" || !!layoutProblem}
                  onClick={() => void run("stress")}
                >
                  Stress Test
                </button>
                <button
                  disabled={busy || connection !== "online" || !!layoutProblem}
                  onClick={() => void run("optimize")}
                >
                  Optimize
                </button>
              </div>
            </div>
            <Suspense fallback={<p role="status">Loading analytics…</p>}>
              <AnalyticsDashboard
                result={result}
                stressResult={stressResult}
                building={building}
                optimization={optimization}
                onApply={applyCandidate}
                disabled={busy}
              />
            </Suspense>
          </section>
        </main>
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
