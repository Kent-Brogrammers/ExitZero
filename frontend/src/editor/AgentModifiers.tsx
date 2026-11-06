import { useEffect, useId, useRef, useState } from "react";
import type {
  AgentModifier,
  AgentModifierParameters,
  BuildingScenario,
} from "../types/simulation";
import { NumberInput } from "../ui/NumberInput";
import { formatLength } from "../utils/units";
import { useDisplayUnits } from "../utils/useDisplayUnits";
import {
  automaticModifiers,
  modifierFields,
  withAutomaticModifiers,
} from "./agentModifiers";
import "./AgentModifiers.css";

const descriptions: Record<string, string> = {
  curious:
    "Explores until personally seeing the emergency, then evacuates. Normal behavior in a basic evacuation.",
  older: "A slower walking pace and gentler acceleration.",
  scared: "Pauses before reacting, then moves slowly and avoids known hazards.",
  aggressive: "Moves faster and takes priority when people need to yield.",
  calm: "Prefers less crowded routes and avoids known hazards.",
  limited_mobility: "Reduced walking speed and acceleration.",
};

export function AgentModifiersDialog({
  building,
  onApply,
  onClose,
}: {
  building: BuildingScenario;
  onApply: (next: BuildingScenario) => boolean;
  onClose: () => void;
}) {
  useDisplayUnits();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [source] = useState(building);
  const [initial] = useState(() => withAutomaticModifiers(building));
  const [definitions, setDefinitions] = useState<AgentModifier[]>(() =>
    structuredClone(initial.agent_modifiers ?? []),
  );
  const [allowed, setAllowed] = useState(() => [
    ...(initial.spawn_modifier_ids ?? []),
  ]);
  const [variation, setVariation] = useState(
    initial.agent_speed_variation ?? 0.05,
  );
  const [fraction, setFraction] = useState(initial.personality_fraction ?? 0.3);
  const [error, setError] = useState("");
  const stale = source !== building;
  const pursuit = !!building.pursuit;
  useEffect(() => {
    const target = dialog.current;
    target?.showModal();
    return () => target?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="agent-modifiers-dialog"
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="modifier-dialog-heading">
        <div>
          <p className="eyebrow">People / Spawn settings</p>
          <h2 id={heading}>Agent personalities</h2>
        </div>
        <button
          type="button"
          className="studio-control studio-control--icon"
          aria-label="Close agent personalities"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="modifier-dialog-intro">
        Selected occupants get one of the allowed personalities automatically
        when a simulation starts. All personalities are allowed by default.
      </p>
      {pursuit ? (
        <p className="note">
          Personalities are available for evacuation scenarios. Pursuit uses its
          own survivor movement settings.
        </p>
      ) : (
        <>
          <div className="modifier-dialog-toolbar">
            <span>
              {allowed.length} of {definitions.length} allowed
            </span>
            <button
              type="button"
              className="studio-control"
              onClick={() => setAllowed(definitions.map((m) => m.id))}
            >
              Allow all
            </button>
            <button
              type="button"
              className="studio-control"
              onClick={() => setAllowed([])}
            >
              Clear all
            </button>
          </div>
          <div className="modifier-card-grid">
            {definitions.map((modifier) => {
              const enabled = allowed.includes(modifier.id);
              return (
                <section
                  className={`modifier-card${enabled ? " is-allowed" : ""}`}
                  key={modifier.id}
                >
                  <label className="modifier-card-toggle">
                    <input
                      type="checkbox"
                      aria-label={`Allow ${modifier.name}`}
                      checked={enabled}
                      onChange={(event) =>
                        setAllowed(
                          event.target.checked
                            ? [...allowed, modifier.id]
                            : allowed.filter((id) => id !== modifier.id),
                        )
                      }
                    />
                    <strong>{modifier.name}</strong>
                    <span>{enabled ? "Allowed" : "Off"}</span>
                  </label>
                  <p>
                    {descriptions[modifier.id] ??
                      "Custom movement and routing preferences."}
                  </p>
                  <div className="modifier-card-facts">
                    <span>
                      {formatLength(1.3 * (modifier.speed_multiplier ?? 1), 2)}
                      /s walking pace
                    </span>
                    {!!modifier.reaction_delay_seconds && (
                      <span>{modifier.reaction_delay_seconds} s reaction</span>
                    )}
                  </div>
                  <details>
                    <summary>Adjust effects</summary>
                    <div className="modifier-effect-fields">
                      {(
                        Object.keys(
                          modifierFields,
                        ) as (keyof AgentModifierParameters)[]
                      ).map((field) => {
                        const [label, min, max] = modifierFields[field];
                        return (
                          <label key={field}>
                            {label}
                            <NumberInput
                              aria-label={`${modifier.name} ${label}`}
                              min={min}
                              max={max}
                              step={0.05}
                              value={
                                modifier[field] ??
                                (field === "reaction_delay_seconds" ? 0 : 1)
                              }
                              onValue={(value) =>
                                setDefinitions(
                                  definitions.map((m) =>
                                    m.id === modifier.id
                                      ? { ...m, [field]: value }
                                      : m,
                                  ),
                                )
                              }
                            />
                          </label>
                        );
                      })}
                    </div>
                  </details>
                </section>
              );
            })}
          </div>
          <div className="modifier-variation">
            <div>
              <strong>Occupants with a personality</strong>
              <p>
                The rest have a neutral personality. This is a seeded chance per
                occupant.
              </p>
            </div>
            <label>
              Occupants (%)
              <NumberInput
                aria-label="Occupants with a personality (%)"
                min={0}
                max={100}
                step={1}
                value={fraction * 100}
                onValue={(v) => setFraction(v / 100)}
              />
            </label>
          </div>
          <div className="modifier-variation">
            <div>
              <strong>Individual walking speed</strong>
              <p>
                Small differences between occupants, even with the same
                personality.
              </p>
            </div>
            <label>
              Variation (±%)
              <NumberInput
                aria-label="Walking speed variation (%)"
                min={0}
                max={20}
                step={1}
                value={variation * 100}
                onValue={(value) => setVariation(value / 100)}
              />
            </label>
          </div>
          <p className="note">
            {allowed.length
              ? "Allowed personalities are picked with equal chance. The same seed keeps assignments consistent across runs."
              : "With none allowed, everyone uses a neutral personality. Walking speed variation still applies."}
          </p>
          <p className="note">
            Illustrative simulation settings. Emergency window capability stays
            controlled by the scenario.
          </p>
        </>
      )}
      {(error || stale) && (
        <p role="alert">
          {stale
            ? "The layout changed. Close and reopen this window to use the current layout."
            : error}
        </p>
      )}
      <div className="modifier-dialog-actions">
        <button type="button" className="studio-control" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="studio-control modifier-save"
          disabled={stale || pursuit}
          onClick={() => {
            const next = {
              ...automaticModifiers(building, definitions, allowed),
              agent_speed_variation: variation,
              personality_fraction: fraction,
            };
            if (onApply(next)) onClose();
            else
              setError(
                "Could not save these settings. Check the layout and try again.",
              );
          }}
        >
          Save changes
        </button>
      </div>
    </dialog>
  );
}
