import { useEffect, useId, useRef, useState } from "react";
import type { BuildingScenario } from "../types/simulation";
import { LengthInput } from "../ui/LengthInput";
import { formatDimensions } from "../utils/units";
import { totalPopulation } from "../utils/population";
import { AppearanceSelector } from "../styles/StudioAppearance";
import { halloweenPreset } from "../editor/presets";
import { TemplatePreview } from "../templates/TemplatePreview";
import { StudioAbout } from "./StudioAbout";
import { StudioKeybinds } from "./StudioKeybinds";
import "./StudioSettings.css";

const sections = [
  ["general", "General"],
  ["keybinds", "Keybinds"],
  ["origins", "Hackathon Origins"],
] as const;
type SettingsSection = (typeof sections)[number][0];

export function StudioSettings({
  building,
  busy,
  connection,
  layoutProblem,
  onChange,
  onRetry,
  onHalloween,
  onClose,
}: {
  building: BuildingScenario;
  busy: boolean;
  connection: "checking" | "online" | "offline";
  layoutProblem: string | null;
  onChange: (building: BuildingScenario) => void;
  onRetry: () => void;
  onHalloween: (action: "edit" | "simulate") => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const outside = useRef(false);
  const id = useId();
  const [section, setSection] = useState<SettingsSection>("general");
  useEffect(() => {
    const target = dialog.current;
    const previous = document.activeElement;
    target?.showModal();
    return () => {
      target?.close();
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        previous.getClientRects().length
      )
        previous.focus();
      else
        document
          .querySelector<HTMLElement>('.studio-nav [aria-selected="true"]')
          ?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      id="studio-settings-dialog"
      className="settings-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "button, input, select, textarea, a[href], summary, [tabindex]",
          ),
        ].filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(":disabled") &&
            element.getClientRects().length,
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
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
      <header className="settings-dialog-heading">
        <div>
          <h2 id={`${id}-title`}>Settings</h2>
          <p>Workspace preferences and project details</p>
        </div>
        <button
          type="button"
          className="studio-control studio-control--icon"
          aria-label="Close Settings"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="settings-dialog-main">
        <nav
          className="settings-sections"
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="vertical"
          onKeyDown={(event) => {
            if (
              ![
                "ArrowDown",
                "ArrowUp",
                "ArrowLeft",
                "ArrowRight",
                "Home",
                "End",
              ].includes(event.key)
            )
              return;
            event.preventDefault();
            const current = sections.findIndex(([value]) => value === section);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? sections.length - 1
                  : (current +
                      (["ArrowDown", "ArrowRight"].includes(event.key)
                        ? 1
                        : sections.length - 1)) %
                    sections.length;
            setSection(sections[next]![0]);
            document.getElementById(`${id}-${sections[next]![0]}`)?.focus();
          }}
        >
          {sections.map(([value, label]) => (
            <button
              type="button"
              key={value}
              id={`${id}-${value}`}
              role="tab"
              aria-selected={section === value}
              aria-controls={`${id}-panel`}
              tabIndex={section === value ? 0 : -1}
              onClick={() => setSection(value)}
            >
              {label}
            </button>
          ))}
        </nav>
        <section
          key={section}
          id={`${id}-panel`}
          className="settings-dialog-body"
          role="tabpanel"
          aria-labelledby={`${id}-${section}`}
          tabIndex={0}
        >
          {section === "general" && (
            <div className="settings-content">
              <section className="settings-section">
                <h3>Appearance & units</h3>
                <AppearanceSelector />
                <dl className="settings-values">
                  <div>
                    <dt>Display units</dt>
                    <dd>Feet (ft)</dd>
                  </div>
                </dl>
                <p className="note">
                  Layout JSON and simulation coordinates stay in meters.
                </p>
              </section>
              <section className="settings-section">
                <h3>Simulation preferences</h3>
                <fieldset disabled={busy}>
                  <legend>Agent awareness</legend>
                  {(
                    [
                      ["sight_range_metres", "Sight range (ft)", 8],
                      [
                        "communication_range_metres",
                        "Communication range (ft)",
                        3,
                      ],
                    ] as const
                  ).map(([key, label, fallback]) => (
                    <label key={key}>
                      {label}
                      <LengthInput
                        min={0}
                        max={1000}
                        value={building.awareness?.[key] ?? fallback}
                        onValue={(value) => {
                          if (
                            !Number.isFinite(value) ||
                            value < 0 ||
                            value > 1000
                          )
                            return;
                          onChange({
                            ...building,
                            awareness: {
                              sight_range_metres: 8,
                              communication_range_metres: 3,
                              ...building.awareness,
                              [key]: value,
                            },
                          });
                        }}
                      />
                    </label>
                  ))}
                  <p className="note">
                    Agents assume exits are open until they see or hear
                    otherwise. Walls block sight and communication. Set
                    communication to 0 to disable sharing.
                  </p>
                </fieldset>
              </section>
              <section className="settings-section">
                <h3>Connection & current layout</h3>
                <div className="settings-connection" role="status">
                  <span>
                    <i
                      className={`connection-dot ${connection}`}
                      aria-hidden="true"
                    />
                    Backend {connection}
                  </span>
                  {connection === "offline" && (
                    <button
                      type="button"
                      className="studio-control"
                      onClick={onRetry}
                    >
                      Retry
                    </button>
                  )}
                </div>
                <p className="settings-layout">
                  {formatDimensions(building.width, building.height)} ·{" "}
                  {building.exits.length} exits · {totalPopulation(building)}{" "}
                  occupants
                </p>
                {layoutProblem && (
                  <p className="settings-warning">{layoutProblem}</p>
                )}
              </section>
            </div>
          )}
          {section === "keybinds" && (
            <>
              <h3 className="settings-panel-title">Keybinds</h3>
              <StudioKeybinds />
            </>
          )}
          {section === "origins" && (
            <div className="settings-origins">
              <h3 className="settings-panel-title">Hackathon Origins</h3>
              <p>
                ExitZero began as a four-person project for the 2026 Stark State
                Halloween Hackathon.
              </p>
              <p>
                We wanted to go beyond watching an evacuation: design a
                building, test what happens when routes fail, discover
                bottlenecks, and measure improvements. That idea grew into
                ExitZero Studio.
              </p>
              <section className="settings-origin-demo">
                <h4>{halloweenPreset.label}</h4>
                <p>
                  A fictional, single-floor pursuit through a horror-movie
                  house. Survivors seek an escape while a masked stalker follows
                  them. Movement and outcomes come from the Rust simulation.
                </p>
                <div className="settings-origins-preview" data-halloween="true">
                  <TemplatePreview
                    name={halloweenPreset.label}
                    building={halloweenPreset.building}
                  />
                </div>
                <div className="settings-origin-actions">
                  <button
                    type="button"
                    className="studio-control settings-play"
                    disabled={busy || connection !== "online"}
                    title={
                      connection !== "online"
                        ? "Connect to the backend to play"
                        : "Run the Halloween pursuit"
                    }
                    onClick={() => onHalloween("simulate")}
                  >
                    Play Halloween map ↗
                  </button>
                  <button
                    type="button"
                    className="studio-control"
                    disabled={busy}
                    onClick={() => onHalloween("edit")}
                  >
                    Edit house
                  </button>
                </div>
                <p className="note">
                  Opening the house replaces the current layout after the usual
                  unsaved-changes confirmation. Select a standard template to
                  return to regular evacuation design.
                </p>
              </section>
              <StudioAbout />
            </div>
          )}
        </section>
      </div>
      <footer className="settings-dialog-actions">
        <span>Preferences apply as you edit.</span>
        <button type="button" className="studio-control" onClick={onClose}>
          Done
        </button>
      </footer>
    </dialog>
  );
}
