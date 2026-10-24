import { lazy, Suspense, useEffect, useState } from "react";
import example from "../../shared/examples/building.json";
import { buildingError } from "./editor/geometry";
import { BuildingWorkspace } from "./editor/BuildingWorkspace";
import { api } from "./services/api";
import type {
  BuildingScenario,
  SimulationResult,
  StressTestResult,
} from "./types/simulation";

const AnalyticsDashboard = lazy(() => import("./analytics/AnalyticsDashboard"));

export default function App() {
  const [building, setBuilding] = useState<BuildingScenario>(() =>
    structuredClone(example),
  );
  const layoutProblem = buildingError(building);
  function changeBuilding(next: BuildingScenario) {
    setBuilding(next);
    setResult(null);
    setStressResult(null);
    setMessage("Layout updated. Export JSON to save your work.");
  }
  const [connection, setConnection] = useState<
    "checking" | "online" | "offline"
  >("checking");
  const [healthAttempt, setHealthAttempt] = useState(0);
  const [showMock, setShowMock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    "The sample layout is ready. Computation endpoints are scaffolded and return 501 until implemented.",
  );
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [stressResult, setStressResult] = useState<StressTestResult | null>(
    null,
  );

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
        setShowMock(false);
        setMessage("Simulation result received.");
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
        setMessage(
          "Stress-test result received. Scenario comparison rendering is pending.",
        );
      } else {
        await api.optimize({ building, max_candidates: 10 });
        setMessage(
          "Optimization result received. Candidate visualization is pending.",
        );
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace-app">
      <header className="app-header">
        <a className="brand" href="#building">
          <span className="brand-icon" aria-hidden="true">
            ↗
          </span>
          ExitZero<span className="brand-caption">Evacuation workspace</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#building">Building</a>
          <a href="#simulation">Simulation</a>
          <a href="#analytics">Analytics</a>
        </nav>
        <div className={`connection ${connection}`} role="status">
          <span className="status-dot" />
          Backend {connection}
          {connection === "offline" && (
            <button
              className="text-button"
              onClick={() => {
                setConnection("checking");
                setHealthAttempt((attempt) => attempt + 1);
              }}
            >
              Retry
            </button>
          )}
        </div>
      </header>
      <main>
        <div className="page-heading">
          <h1>Evacuation workspace</h1>
          <span className="badge">Design. Simulate. Stress test.</span>
        </div>
        <section className="controls panel" aria-label="Simulation controls">
          <div className="scenario-summary">
            <strong>Current layout</strong>
            <span>
              {building.width} × {building.height} m · {building.exits.length}{" "}
              exits ·{" "}
              {building.spawn_zones.reduce(
                (total, zone) => total + zone.count,
                0,
              )}{" "}
              occupants · seed {building.seed}
            </span>
          </div>
          <div className="control-buttons">
            <button
              className="primary"
              disabled={busy || connection !== "online" || !!layoutProblem}
              onClick={() => void run("simulate")}
            >
              Run simulation
            </button>
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
        </section>
        <p className="request-message" role="status">
          {layoutProblem ?? message}
        </p>
        <BuildingWorkspace
          building={building}
          onChange={changeBuilding}
          result={result}
          disabled={busy}
        />
        <div className="preview-control">
          <label>
            <input
              type="checkbox"
              checked={showMock}
              onChange={(event) => setShowMock(event.target.checked)}
            />
            Show mock analytics preview
          </label>
          <span>Synthetic fixture for frontend development</span>
        </div>
        <Suspense fallback={<p role="status">Loading analytics…</p>}>
          <AnalyticsDashboard
            result={result}
            stressResult={stressResult}
            showMock={showMock}
          />
        </Suspense>
        <footer>
          ExitZero · Local prototype · Simulation, stress testing, and
          optimization are not implemented.
        </footer>
      </main>
    </div>
  );
}
