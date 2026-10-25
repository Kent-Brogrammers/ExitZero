import { defaultDynamics } from "./disasterDynamics";
import { useId, useState } from "react";
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
  function choose(value: string) {
    setSettingsOpen(Boolean(value));
    if (!value) {
      const next = { ...building };
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
      ...building,
      disaster: {
        kind: value as DisasterKind,
        dynamics: defaultDynamics(
          value as DisasterKind,
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
      <label>
        Emergency scenario
        <select
          aria-label="Emergency scenario"
          value={disaster?.kind ?? ""}
          onChange={(e) => choose(e.target.value)}
        >
          <option value="">Baseline evacuation</option>
          <option value="fire">Fire</option>
          <option value="gas_leak">Gas leak</option>
          <option value="tornado">Tornado</option>
        </select>
      </label>
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
                Hazard {axis.toUpperCase()} (m)
                <input
                  type="number"
                  aria-label={`Hazard ${axis.toUpperCase()}`}
                  min={0}
                  max={axis === "x" ? building.width : building.height}
                  step="0.1"
                  value={disaster.center[axis]}
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber;
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
              Hazard radius (m)
              <input
                type="number"
                aria-label="Hazard radius"
                min="0.1"
                max="1000"
                step="0.1"
                value={disaster.radius}
                onChange={(e) => {
                  const radius = e.target.valueAsNumber;
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
                        ["speed", "Speed (m/s)", 0, 10, 0.1],
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
                          "Extra shelter clearance (m)",
                          0,
                          20,
                          0.1,
                        ],
                      ]
                    : disaster.kind === "gas_leak"
                      ? [
                          ["growth_rate", "Growth rate (m/s)", 0, 2, 0.01],
                          [
                            "max_radius",
                            "Maximum cloud radius (m)",
                            0.01,
                            1000,
                            0.1,
                          ],
                        ]
                      : [
                          ["growth_rate", "Growth rate (m/s)", 0, 2, 0.01],
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
                            "Maximum patch radius (m)",
                            0.01,
                            1000,
                            0.1,
                          ],
                        ]
                  ).map(([key, label, min, max, step]) => (
                    <label key={key}>
                      {label}
                      <input
                        type="number"
                        aria-label={String(label)}
                        min={min}
                        max={max}
                        step={step}
                        disabled={!dynamics.enabled}
                        value={
                          dynamics[
                            key as Exclude<keyof DisasterDynamics, "enabled">
                          ]
                        }
                        onChange={(e) => {
                          const value = e.target.valueAsNumber;
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
                  ))}
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
                  {disaster.kind === "gas_leak"
                    ? "Gas stays one cloud at its source and expands at the configured growth rate."
                    : disaster.kind === "fire"
                      ? "New flames ignite along exposed edges of existing fire. Spread is repeatable from the building seed."
                      : "Random motion is repeatable from the building seed. Tornado clearance protects the whole exposure area around each shelter."}
                </p>
              </details>
            )}
            <p className="note">
              {disaster.kind === "tornado"
                ? "Drag a Tornado zone on the plan. The alarm sends occupants to shelter, rather than exits."
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
