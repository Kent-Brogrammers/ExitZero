import type { BuildingScenario } from "../types/simulation";
import { LengthInput } from "../ui/LengthInput";

export function PursuitControls({
  building,
  onChange,
}: {
  building: BuildingScenario;
  onChange: (b: BuildingScenario) => void;
}) {
  const pursuit = building.pursuit;
  if (!pursuit) return null;
  return (
    <section
      className="pursuit-controls"
      aria-label="Halloween pursuit settings"
    >
      <strong>Halloween — The Pursuit</strong>
      <div className="pursuit-settings-fields">
        <p>
          Escape the masked stalker. Orange dots are survivors; the red mask is
          the stalker. Fictional game mode, not a safety prediction.
        </p>
        {(["x", "y"] as const).map((axis) => (
          <label key={axis}>
            Stalker start {axis.toUpperCase()} (ft)
            <LengthInput
              aria-label={`Stalker start ${axis.toUpperCase()}`}
              value={pursuit.stalker_start[axis]}
              min={0}
              max={axis === "x" ? building.width : building.height}
              onValue={(value) => {
                if (Number.isFinite(value))
                  onChange({
                    ...building,
                    pursuit: {
                      ...pursuit,
                      stalker_start: {
                        ...pursuit.stalker_start,
                        [axis]: value,
                      },
                    },
                  });
              }}
            />
          </label>
        ))}
        {(["stalker_speed", "survivor_speed"] as const).map((key) => (
          <label key={key}>
            {key === "stalker_speed" ? "Stalker" : "Survivor"} speed (ft/s)
            <LengthInput
              aria-label={
                key === "stalker_speed" ? "Stalker speed" : "Survivor speed"
              }
              value={pursuit[key]}
              min={0.1}
              max={3}
              onValue={(value) => {
                if (Number.isFinite(value) && value >= 0.1 && value <= 3)
                  onChange({
                    ...building,
                    pursuit: { ...pursuit, [key]: value },
                  });
              }}
            />
          </label>
        ))}
        <p>
          Known house layout; survivors avoid a visible stalker while routing to
          exits. Blocked routes can force emergency window preparation and
          traversal. The stalker pursues the nearest reachable survivor;
          physical contact catches them immediately.
        </p>
      </div>
      <button
        type="button"
        className="studio-control"
        onClick={() => {
          const next = { ...building };
          delete next.pursuit;
          onChange(next);
        }}
      >
        Use normal evacuation
      </button>
    </section>
  );
}
