import { gridSpacings, type DraftingPreferences } from "./drafting";
export function DraftingControls({
  preferences,
  onChange,
}: {
  preferences: DraftingPreferences;
  onChange: (p: DraftingPreferences) => void;
}) {
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
              {value} m
            </option>
          ))}
        </select>
      </label>
      <p className="note">
        1 ft = 0.3048 m. Geometry stays in metres. Snapping works with the grid
        hidden. With Snap to Grid on, door/exit edges use this merge tolerance.
        Confirm the preview to merge; gaps remain when snapping is off.
      </p>
    </div>
  );
}
