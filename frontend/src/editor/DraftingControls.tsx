import { formatLength } from "../utils/units";
import { gridSpacings, type DraftingPreferences } from "./drafting";
import { measurementOptions, measurementVisibility } from "./measurements";
export function DraftingControls({
  preferences,
  onChange,
}: {
  preferences: DraftingPreferences;
  onChange: (p: DraftingPreferences) => void;
}) {
  const measurements = measurementVisibility(preferences.measurements);
  return (
    <div className="drafting-controls">
      <h3>Measurement grid</h3>
      <label>
        <input
          type="checkbox"
          checked={preferences.visible}
          onChange={(e) =>
            onChange({ ...preferences, visible: e.target.checked })
          }
        />
        Show grid
      </label>
      <label>
        Grid spacing
        <select
          aria-label="Grid spacing"
          value={preferences.spacing}
          onChange={(e) =>
            onChange({
              ...preferences,
              spacing: e.target.value as DraftingPreferences["spacing"],
            })
          }
        >
          {Object.entries(gridSpacings).map(([key, p]) => (
            <option key={key} value={key}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={preferences.snap}
          onChange={(e) => onChange({ ...preferences, snap: e.target.checked })}
        />
        Snap to Grid
      </label>
      <fieldset className="drafting-measurements">
        <legend>Show measurements</legend>
        <div>
          {measurementOptions.map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={measurements[key]}
                onChange={(event) =>
                  onChange({
                    ...preferences,
                    measurements: {
                      ...measurements,
                      [key]: event.target.checked,
                    },
                  })
                }
              />
              {label}
            </label>
          ))}
        </div>
        <p className="note">
          Feet · wall centreline lengths and opening widths. Live drawing
          measurements stay on.
        </p>
      </fieldset>
      <h3>Wall snapping</h3>
      <label>
        <input
          type="checkbox"
          checked={preferences.snapEndpoints !== false}
          onChange={(e) =>
            onChange({ ...preferences, snapEndpoints: e.target.checked })
          }
        />
        Snap to wall endpoints, corners &amp; segments
      </label>
      <p className="note">
        Draw straight walls or drag wall endpoints to the highlighted target.
        Wall targets take priority over the grid. Turning this off leaves grid
        snapping independent.
      </p>
      <h3>Opening snapping</h3>
      <label>
        Door / exit merge snap
        <select
          aria-label="Opening merge snap distance"
          value={preferences.doorMergeTolerance}
          onChange={(e) =>
            onChange({
              ...preferences,
              doorMergeTolerance: Number(e.target.value),
            })
          }
        >
          {[0.02, 0.05, 0.1, 0.2].map((value) => (
            <option key={value} value={value}>
              {formatLength(value, 2)}
            </option>
          ))}
        </select>
      </label>
      <p className="note">
        Distances are shown in feet. Snapping works with the grid hidden. With
        Snap to Grid on, door/exit edges use this merge tolerance. Confirm the
        preview to merge; gaps remain when snapping is off.
      </p>
    </div>
  );
}
