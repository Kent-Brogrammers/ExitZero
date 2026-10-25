import type { BuildingScenario, WindowOpening } from "../types/simulation";

/** Explicit scenario assumptions; changing these never renames or replaces an opening. */
export function WindowProperties({
  building,
  window: pane,
  onChange,
}: {
  building: BuildingScenario;
  window: WindowOpening;
  onChange: (next: BuildingScenario) => unknown;
}) {
  const escape = pane.emergency_escape;
  const update = (
    patch: Partial<NonNullable<WindowOpening["emergency_escape"]>>,
  ) => {
    const next = structuredClone(building);
    next.windows!.find((w) => w.id === pane.id)!.emergency_escape = {
      enabled: false,
      preparation: "open",
      clear_width_metres: pane.width,
      clear_height_metres: 1.2,
      preparation_seconds: 5,
      traversal_seconds: 3,
      exterior_side: 1,
      exterior_available: false,
      ...escape,
      ...patch,
    };
    onChange(next);
  };
  const context = building.window_escape_context;
  return (
    <fieldset className="window-properties">
      <legend>Emergency window assumptions</legend>
      <label className="block-toggle">
        <input
          type="checkbox"
          checked={escape?.enabled ?? false}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        Enable last-resort escape
      </label>
      {escape && (
        <>
          <label className="number-field">
            Preparation
            <select
              aria-label="Window preparation"
              value={escape.preparation}
              onChange={(e) =>
                update({ preparation: e.target.value as "open" | "break" })
              }
            >
              <option value="open">Open</option>
              <option value="break">Break</option>
            </select>
          </label>
          {(
            [
              ["clear_width_metres", "Usable width (m)"],
              ["clear_height_metres", "Usable height (m)"],
              ["preparation_seconds", "Preparation delay (s)"],
              ["traversal_seconds", "Traversal delay (s)"],
            ] as const
          ).map(([field, label]) => (
            <WindowNumber
              key={field}
              label={label}
              value={escape[field]}
              onCommit={(value) => update({ [field]: value })}
            />
          ))}
          <label className="number-field">
            Exterior side
            <select
              aria-label="Window exterior side"
              value={escape.exterior_side}
              onChange={(e) =>
                update({ exterior_side: Number(e.target.value) as -1 | 1 })
              }
            >
              <option value={1}>+ normal</option>
              <option value={-1}>− normal</option>
            </select>
          </label>
          <label className="block-toggle">
            <input
              type="checkbox"
              checked={escape.exterior_available}
              onChange={(e) => update({ exterior_available: e.target.checked })}
            />
            Exterior landing is available
          </label>
          <label className="block-toggle">
            <input
              type="checkbox"
              checked={
                !!context &&
                context.floor_elevation_metres === 0 &&
                context.all_agents_can_traverse
              }
              onChange={(e) =>
                onChange({
                  ...building,
                  window_escape_context: {
                    floor_elevation_metres: 0,
                    required_clear_height_metres:
                      context?.required_clear_height_metres ?? 1,
                    all_agents_can_traverse: e.target.checked,
                  },
                })
              }
            />
            Assume ground floor and all occupants can traverse (whole scenario)
          </label>
          {context && (
            <WindowNumber
              label="Required clear height (m)"
              value={context.required_clear_height_metres}
              onCommit={(value) =>
                onChange({
                  ...building,
                  window_escape_context: {
                    ...context,
                    required_clear_height_metres: value,
                  },
                })
              }
            />
          )}
        </>
      )}
      <p className="note">
        The selection arrow points toward the configured exterior. + normal is
        (−dy/L, +dx/L) from the wall start; − normal is the opposite side.
        Ordinary windows are solid. Escape is considered only when all normal
        exits are blocked. Exterior landing and full-body clearance are checked
        by Rust. Timings and capability are user assumptions, not validated
        safety estimates. Intact glazing is opaque in this model.
      </p>
    </fieldset>
  );
}

function WindowNumber({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (n: number) => unknown;
}) {
  return (
    <label className="number-field">
      {label}
      <input
        key={value}
        aria-label={label}
        type="number"
        step="0.1"
        defaultValue={value}
        onBlur={(e) => {
          const n = e.currentTarget.valueAsNumber;
          if (Number.isFinite(n)) onCommit(n);
          e.currentTarget.value = String(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}
