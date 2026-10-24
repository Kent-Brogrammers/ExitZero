import { lazy, Suspense, useEffect, useState } from "react";
import example from "../../shared/examples/building.json";
import { withoutObjectNames } from "./editor/names";
import { buildingError } from "./editor/geometry";
import { BuildingWorkspace } from "./editor/BuildingWorkspace";
import { StudioPopover } from "./ui/StudioPopover";
import { AppearanceSelector } from "./styles/StudioAppearance";
import { StudioWelcome } from "./studio/StudioWelcome";
import { api } from "./services/api";
import {
  applyOptimizationCandidate,
  type OptimizationEvaluation,
} from "./analytics/optimization";
import type {
  BuildingScenario,
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
    setMessage("");
  }
  const [connection, setConnection] = useState<
    "checking" | "online" | "offline"
  >("checking");
  const [healthAttempt, setHealthAttempt] = useState(0);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<SimulationResult | null>(null);
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
    setBusy(true);
    setMessage("Sending request to the backend…");
    try {
      if (action === "simulate") {
        setResult(await api.simulate(building));

        setMessage("Simulation result received.");
        navigate("simulation");
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
        setMessage("Stress-test result received.");
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
      setBusy(false);
    }
  }

  return (
    <div className={`workspace-app${view === "welcome" ? " is-welcome" : ""}`}>
      <div className="welcome-view" hidden={view !== "welcome"}>
        <StudioWelcome
          building={example}
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
              {busy ? "Working…" : "Run simulation"}
              <span aria-hidden="true">↗</span>
            </button>
          </div>
        </header>
        <main className="studio-main">
          <h1 className="sr-only">ExitZero Studio</h1>
          <div className="studio-viewport" hidden={view === "analytics"}>
            <BuildingWorkspace
              building={building}
              onChange={changeBuilding}
              result={result}
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
                <p className="eyebrow">THE RECORD / ANALYTICS</p>
                <h2>
                  Every outcome.
                  <br />
                  <span>A clearer picture.</span>
                </h2>
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
                  Stress test
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
