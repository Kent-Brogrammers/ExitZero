import { defaultDynamics } from "./disasterDynamics";
import { PursuitControls } from "./PursuitControls";
import { useEffect, useId, useRef, useState } from "react";
import { buildingError } from "./geometry";
import { ToolIcon } from "./ToolIcon";
import { LengthInput } from "../ui/LengthInput";
import { lengthFromInput, lengthInputValue, toFeet } from "../utils/units";
import type {
  BuildingScenario,
  DisasterKind,
  DisasterDynamics,
} from "../types/simulation";
import "./ScenarioSettings.css";

interface ScenarioProps {
  building: BuildingScenario;
  onChange: (next: BuildingScenario) => void | boolean;
  onLocate: () => void;
}

export function DisasterControls(props: ScenarioProps) {
  const [open, setOpen] = useState(false);
  const label = props.building.pursuit
    ? "Halloween pursuit"
    : (props.building.disaster?.kind.replace("gas_leak", "gas leak") ??
      "Evacuation");
  return (
    <>
      <button
        type="button"
        className="studio-control rail-button"
        title={`Edit scenario · ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <ToolIcon name="shelter" />
        <span>Scenario</span>
      </button>
      {open && <ScenarioDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function ScenarioDialog({
  building,
  onChange,
  onLocate,
  onClose,
}: ScenarioProps & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const firstFocus = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<HTMLButtonElement>(null);
  const outside = useRef(false);
  const id = useId();
  const [draft, setDraft] = useState(() => structuredClone(building));
  const [error, setError] = useState("");
  useEffect(() => {
    const target = dialog.current;
    const previous = document.activeElement;
    target?.showModal();
    return () => {
      target?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  function apply(locate = false) {
    const problem = buildingError(draft, false);
    if (problem) {
      setError(problem);
      return;
    }
    if (
      JSON.stringify(draft) !== JSON.stringify(building) &&
      onChange(draft) === false
    ) {
      setError(
        "The scenario could not be applied. Check the layout and try again.",
      );
      return;
    }
    onClose();
    if (locate) requestAnimationFrame(onLocate);
  }
  return (
    <dialog
      ref={dialog}
      className="scenario-dialog"
      aria-labelledby={id}
      aria-describedby={`${id}-hint`}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        if (event.shiftKey && document.activeElement === firstFocus.current) {
          event.preventDefault();
          lastFocus.current?.focus();
        } else if (
          !event.shiftKey &&
          document.activeElement === lastFocus.current
        ) {
          event.preventDefault();
          firstFocus.current?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        const r = event.currentTarget.getBoundingClientRect();
        outside.current =
          event.target === event.currentTarget &&
          (event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom);
      }}
      onClick={(event) => {
        if (outside.current && event.target === event.currentTarget) onClose();
        outside.current = false;
      }}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <header className="scenario-dialog-heading">
          <div>
            <p className="eyebrow">Simulation setup</p>
            <h2 id={id}>Edit scenario</h2>
          </div>
          <button
            type="button"
            className="studio-control studio-control--icon"
            aria-label="Close scenario settings"
            ref={firstFocus}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="scenario-dialog-body">
          <p id={`${id}-hint`} className="scenario-dialog-hint">
            Configure the next simulation. Changes stay here until you apply
            them.
          </p>
          <ScenarioFields
            building={draft}
            onChange={(next) => {
              setDraft(next);
              setError("");
            }}
            onLocate={() => apply(true)}
          />
          {error && (
            <p role="alert" className="scenario-dialog-error">
              {error}
            </p>
          )}
        </div>
        <footer className="scenario-dialog-actions">
          <button type="button" className="studio-control" onClick={onClose}>
            Cancel
          </button>
          <button
            ref={lastFocus}
            type="submit"
            className="studio-control scenario-apply"
          >
            Apply
          </button>
        </footer>
      </form>
    </dialog>
  );
}

export function ScenarioFields({
  building,
  onChange,
  onLocate,
}: {
  building: BuildingScenario;
  onChange: (next: BuildingScenario) => void;
  onLocate: () => void;
}) {
  const pickerId = useId();
  const disaster = building.disaster;
  const dynamics = disaster
    ? (disaster.dynamics ?? {
        ...defaultDynamics(disaster.kind, disaster.radius),
        enabled: false,
      })
    : null;
  function updateDynamics(patch: Partial<DisasterDynamics>) {
    if (disaster && dynamics)
      onChange({
        ...building,
        disaster: { ...disaster, dynamics: { ...dynamics, ...patch } },
      });
  }
  function choose(value: DisasterKind | "") {
    const ordinary = { ...building };
    delete ordinary.pursuit;
    if (!value) {
      const next = ordinary;
      delete next.disaster;
      onChange(next);
      return;
    }
    const exit = building.exits[0];
    const wall = building.walls.find((w) => w.id === exit?.wall_id);
    const fraction =
      exit && wall
        ? (exit.offset + exit.width / 2) /
          Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y)
        : 0;
    onChange({
      ...ordinary,
      disaster: {
        kind: value,
        dynamics: defaultDynamics(
          value,
          disaster?.radius ??
            Math.min(2, Math.min(building.width, building.height) / 5),
        ),
        center:
          disaster?.center ??
          (wall
            ? {
                x: wall.start.x + (wall.end.x - wall.start.x) * fraction,
                y: wall.start.y + (wall.end.y - wall.start.y) * fraction,
              }
            : { x: building.width / 2, y: building.height / 2 }),
        radius:
          disaster?.radius ??
          Math.min(2, Math.min(building.width, building.height) / 5),
      },
    });
  }
  return (
    <div className="disaster-controls">
      <PursuitControls building={building} onChange={onChange} />
      <fieldset className="scenario-picker">
        <legend>Scenario</legend>
        <div className="scenario-options">
          {(
            [
              [
                "",
                "Evacuation",
                "Baseline evacuation",
                "M9 4H4v16h5 M9 12h11 M16 8l4 4-4 4",
              ],
              [
                "fire",
                "Fire",
                "Fire evacuation",
                "M13 3c1 5-4 5-2 9 2-1 3-3 3-3 4 5 5 9 1 12-6 3-12-3-8-9 0 3 2 3 2 3-2-6 4-7 4-12Z",
              ],
              [
                "gas_leak",
                "Gas leak",
                "Gas leak evacuation",
                "M4 15h12a4 4 0 1 0-2-7 4 4 0 0 0-8 0 3.5 3.5 0 0 0-2 7 M7 18v3 M12 18v2 M17 18v3",
              ],
              [
                "tornado",
                "Tornado",
                "Indoor shelter response",
                "M3 4h18 M5 8h15 M8 12h10 M10 16h6 M12 20h3",
              ],
            ] as const
          ).map(([kind, label, description, path]) => (
            <label
              key={kind}
              className="scenario-option"
              data-scenario={kind || "baseline"}
              title={description}
            >
              <input
                type="radio"
                name={pickerId}
                value={kind}
                aria-label={description}
                checked={!building.pursuit && (disaster?.kind ?? "") === kind}
                onChange={() => choose(kind)}
              />
              <span className="scenario-choice">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d={path} />
                </svg>
                {label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {disaster && (
        <>
          <section className="scenario-section">
            <h3>Hazard placement</h3>
            <div className="scenario-field-grid">
              {(["x", "y"] as const).map((axis) => (
                <label key={axis}>
                  Hazard {axis.toUpperCase()} (ft)
                  <LengthInput
                    aria-label={`Hazard ${axis.toUpperCase()}`}
                    min={0}
                    max={axis === "x" ? building.width : building.height}
                    value={disaster.center[axis]}
                    onValue={(value) => {
                      if (Number.isFinite(value))
                        onChange({
                          ...building,
                          disaster: {
                            ...disaster,
                            center: {
                              ...disaster.center,
                              [axis]: Math.max(
                                0,
                                Math.min(
                                  axis === "x"
                                    ? building.width
                                    : building.height,
                                  value,
                                ),
                              ),
                            },
                          },
                        });
                    }}
                  />
                </label>
              ))}
              <label>
                Hazard radius (ft)
                <LengthInput
                  aria-label="Hazard radius"
                  min={0.1}
                  max={1000}
                  value={disaster.radius}
                  onValue={(radius) => {
                    if (Number.isFinite(radius) && radius > 0)
                      onChange({
                        ...building,
                        disaster: {
                          ...disaster,
                          radius,
                          ...(disaster.dynamics
                            ? {
                                dynamics: {
                                  ...disaster.dynamics,
                                  max_radius: Math.max(
                                    radius,
                                    disaster.dynamics.max_radius,
                                  ),
                                },
                              }
                            : {}),
                        },
                      });
                  }}
                />
              </label>
            </div>
            <button
              type="button"
              className="studio-control scenario-place"
              onClick={onLocate}
            >
              Apply & place hazard on plan
            </button>
            <p className="note">
              Apply these settings, then click the floor plan to place the
              hazard.
            </p>
          </section>
          {dynamics && (
            <details className="disaster-dynamics scenario-section" open>
              <summary>
                {disaster.kind === "tornado"
                  ? "Tornado movement settings"
                  : disaster.kind === "gas_leak"
                    ? "Cloud growth settings"
                    : "Spread settings"}
              </summary>
              <label className="disaster-enable">
                <input
                  type="checkbox"
                  checked={dynamics.enabled}
                  onChange={(e) =>
                    updateDynamics({ enabled: e.target.checked })
                  }
                />
                {disaster.kind === "tornado"
                  ? "Enable movement"
                  : disaster.kind === "gas_leak"
                    ? "Enable growth"
                    : "Enable spread"}
              </label>
              <div className="disaster-parameters">
                {(disaster.kind === "tornado"
                  ? [
                      ["speed", "Speed (ft/s)", 0, 10, 0.1],
                      ["turn_rate_degrees", "Turning speed (deg/s)", 1, 180, 1],
                      [
                        "wander_interval_seconds",
                        "Change direction every (s)",
                        0.25,
                        60,
                        0.25,
                      ],
                      [
                        "shelter_clearance",
                        "Extra shelter clearance (ft)",
                        0,
                        20,
                        0.1,
                      ],
                    ]
                  : [
                      ["growth_rate", "Growth rate (ft/s)", 0, 2, 0.01],
                      [
                        "spread_interval_seconds",
                        "New patch every (s)",
                        0.25,
                        60,
                        0.25,
                      ],
                      ["max_patches", "Maximum patches", 1, 64, 1],
                      [
                        "max_radius",
                        disaster.kind === "gas_leak"
                          ? "Maximum cloud radius (ft)"
                          : "Maximum patch radius (ft)",
                        0.01,
                        1000,
                        0.1,
                      ],
                    ]
                )
                  .filter(
                    ([key]) =>
                      disaster.kind !== "gas_leak" ||
                      !["spread_interval_seconds", "max_patches"].includes(
                        String(key),
                      ),
                  )
                  .map(([key, label, min, max, step]) => {
                    const distance = [
                      "speed",
                      "shelter_clearance",
                      "growth_rate",
                      "max_radius",
                    ].includes(String(key));
                    const current =
                      dynamics[
                        key as Exclude<keyof DisasterDynamics, "enabled">
                      ];
                    return (
                      <label key={key}>
                        {label}
                        <input
                          type="number"
                          aria-label={String(label)}
                          min={distance ? toFeet(Number(min)) : min}
                          max={distance ? toFeet(Number(max)) : max}
                          step={distance ? "any" : step}
                          disabled={!dynamics.enabled}
                          value={distance ? lengthInputValue(current) : current}
                          onChange={(e) => {
                            const input = e.target.valueAsNumber;
                            const value = distance
                              ? lengthFromInput(input, current)
                              : input;
                            if (
                              Number.isFinite(value) &&
                              value >= Number(min) &&
                              value <= Number(max) &&
                              (key !== "max_patches" || Number.isInteger(value))
                            )
                              updateDynamics({ [String(key)]: value });
                          }}
                        />
                      </label>
                    );
                  })}
              </div>
              <p className="note">
                {disaster.kind === "tornado"
                  ? "Movement keeps the exposure area clear of shelter zones."
                  : "Growth and new patches are repeatable from the scenario seed."}
              </p>
            </details>
          )}
          <p className="note">
            {disaster.kind === "tornado"
              ? "After Apply, draw Tornado zones on the plan to mark indoor shelters."
              : "Affected openings close automatically. Agents discover the location by sight, contact or nearby reports."}
          </p>
        </>
      )}
      <section className="scenario-section">
        <h3>Repeatability</h3>
        <label>
          Scenario random seed
          <input
            type="number"
            aria-label="Scenario random seed"
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            value={building.seed}
            onChange={(e) => {
              const seed = e.currentTarget.valueAsNumber;
              if (Number.isSafeInteger(seed) && seed >= 0)
                onChange({ ...building, seed });
            }}
          />
        </label>
      </section>
    </div>
  );
}
