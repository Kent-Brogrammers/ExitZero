import { defaultDynamics } from "./disasterDynamics";
import { PursuitControls } from "./PursuitControls";
import { useId, useState } from "react";
import { LengthInput } from "../ui/LengthInput";
import { lengthFromInput, lengthInputValue, toFeet } from "../utils/units";
import type {
  BuildingScenario,
  DisasterKind,
  DisasterDynamics,
} from "../types/simulation";

export function DisasterControls({
  building,
  onChange,
  onLocate,
}: {
  building: BuildingScenario;
  onChange: (next: BuildingScenario) => void;
  onLocate: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(true);
  const settingsId = useId();
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
    setSettingsOpen(Boolean(value));
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
          <button
            type="button"
            className="studio-control"
            aria-expanded={settingsOpen}
            aria-controls={settingsId}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            {settingsOpen ? "Hide hazard settings" : "Show hazard settings"}
          </button>
          <div
            id={settingsId}
            className="hazard-settings-content"
            hidden={!settingsOpen}
          >
            <button type="button" className="studio-control" onClick={onLocate}>
              Place hazard on plan
            </button>
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
                                axis === "x" ? building.width : building.height,
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
            {dynamics && (
              <details className="disaster-dynamics">
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
                        [
                          "turn_rate_degrees",
                          "Turning speed (deg/s)",
                          1,
                          180,
                          1,
                        ],
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
                            value={
                              distance ? lengthInputValue(current) : current
                            }
                            onChange={(e) => {
                              const input = e.target.valueAsNumber;
                              const value = distance
                                ? lengthFromInput(input, current)
                                : input;
                              if (
                                Number.isFinite(value) &&
                                value >= Number(min) &&
                                value <= Number(max) &&
                                (key !== "max_patches" ||
                                  Number.isInteger(value))
                              )
                                updateDynamics({ [String(key)]: value });
                            }}
                          />
                        </label>
                      );
                    })}
                </div>
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
                <p className="note">
                  Random motion is repeatable from the building seed. Tornado
                  clearance protects the whole exposure area around each
                  shelter.
                </p>
              </details>
            )}
            <p className="note">
              {disaster.kind === "tornado"
                ? "Drag a Tornado zone on the plan. The alarm sends occupants to shelter, rather than exits."
                : disaster.kind === "gas_leak"
                  ? "The alarm sends occupants to exits. Gas injures and slows people but leaves passages open; they risk exposure if no clear route or usable escape window remains."
                  : "The alarm sends occupants to exits. Openings inside the hazard's exposure area close automatically."}{" "}
              Use Select / move to drag the hazard's centre marker, or enter its
              X/Y coordinates. Agents discover the location by sight, contact or
              nearby reports. Exposure accumulates injury and slows movement;
              orange/red agents are injured. These are exploratory effects, not
              calibrated injury predictions.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
