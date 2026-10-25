import { lengthInputValue, lengthFromInput } from "../utils/units";
import type { BuildingScenario, WindowOpening } from "../types/simulation";
import { configureWindowEscape, suggestedWindowExterior } from "./openings";

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
  const suggestedSide = suggestedWindowExterior(building, pane);
  const wall = building.walls.find((w) => w.id === pane.wall_id);
  const direction = (side: -1 | 1) => {
    if (!wall) return side === 1 ? "+ normal" : "− normal";
    const dx = -(wall.end.y - wall.start.y) * side;
    const dy = (wall.end.x - wall.start.x) * side;
    const parts = [];
    if (Math.abs(dy) > Math.abs(dx) * 0.01) parts.push(dy < 0 ? "up" : "down");
    if (Math.abs(dx) > Math.abs(dy) * 0.01)
      parts.push(dx < 0 ? "left" : "right");
    return `Toward ${parts.join(" / ")}`;
  };
  const update = (
    patch: Partial<NonNullable<WindowOpening["emergency_escape"]>>,
  ) => {
    onChange(configureWindowEscape(building, pane, patch));
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
              ["clear_width_metres", "Usable width (ft)"],
              ["clear_height_metres", "Usable height (ft)"],
              ["preparation_seconds", "Preparation delay (s)"],
              ["traversal_seconds", "Traversal delay (s)"],
            ] as const
          ).map(([field, label]) => (
            <WindowNumber
              key={field}
              distance={field.endsWith("_metres")}
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
              <option value={1}>{direction(1)}</option>
              <option value={-1}>{direction(-1)}</option>
            </select>
          </label>
          {suggestedSide !== null && escape.exterior_side !== suggestedSide && (
            <>
              <p className="note">
                The exterior arrow points toward every occupied spawn zone.
                Check that it points outside.
              </p>
              <button
                type="button"
                onClick={() => update({ exterior_side: suggestedSide })}
              >
                Point exterior away from occupants
              </button>
            </>
          )}
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
              distance
              label="Required clear height (ft)"
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
        Ordinary windows are solid. Enabled windows are a fallback when normal
        exits are blocked or no route around known fire/gas is found. The
        crossing and exterior landing must be clear. Timings and capability are
        user assumptions, not validated safety estimates. Intact glazing is
        opaque in this model.
      </p>
    </fieldset>
  );
}

function WindowNumber({
  distance = false,
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (n: number) => unknown;
  distance?: boolean;
}) {
  const displayed = distance ? lengthInputValue(value) : value;
  return (
    <label className="number-field">
      {label}
      <input
        key={value}
        aria-label={label}
        type="number"
        step="any"
        defaultValue={displayed}
        onBlur={(e) => {
          const input = e.currentTarget.valueAsNumber;
          const n = distance ? lengthFromInput(input, value) : input;
          if (Number.isFinite(n) && n !== value) onCommit(n);
          e.currentTarget.value = String(displayed);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}
