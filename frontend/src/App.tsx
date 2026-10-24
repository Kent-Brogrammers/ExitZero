import { lazy, Suspense, useEffect, useState } from "react";
import example from "../../shared/examples/building.json";
import { BuildingEditor } from "./editor/BuildingEditor";
import { api } from "./services/api";
import { SimulationView } from "./simulation/SimulationView";
import type {
  BuildingScenario,
  SimulationResult,
  StressTestResult,
} from "./types/simulation";

const building: BuildingScenario = example;
const AnalyticsDashboard = lazy(() => import("./analytics/AnalyticsDashboard"));

export default function App() {
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
              blocked_cell_candidates: [],
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
    <>
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
          <div>
            <p className="eyebrow">Local engineering workspace</p>
            <h1>Understand the way out.</h1>
            <p>Design a building. Test its exits. Find a safer layout.</p>
          </div>
          <span className="badge">Foundation / v0.1</span>
        </div>
        <section className="controls panel" aria-label="Simulation controls">
          <div className="scenario-summary">
            <strong>Example building</strong>
            <span>
              {building.width} × {building.height} cells ·{" "}
              {building.exits.length} exits ·{" "}
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
              disabled={busy || connection !== "online"}
              onClick={() => void run("simulate")}
            >
              Run simulation
            </button>
            <button
              disabled={busy || connection !== "online"}
              onClick={() => void run("stress")}
            >
              Stress test
            </button>
            <button
              disabled={busy || connection !== "online"}
              onClick={() => void run("optimize")}
            >
              Optimize
            </button>
          </div>
        </section>
        <p className="request-message" role="status">
          {message}
        </p>
        <div className="workspace-grid">
          <BuildingEditor building={building} />
          <SimulationView result={result} />
        </div>
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
    </>
  );
}
