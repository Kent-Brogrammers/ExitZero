import type { BuildingScenario } from "../types/simulation";
import { useRef } from "react";
import { buildingPresets } from "../editor/presets";
import { TemplateCard } from "../templates/TemplateCard";
import { repositoryUrl } from "./credits";
import { WelcomePreview } from "./WelcomePreview";
import "./StudioWelcome.css";

interface StudioWelcomeProps {
  building: BuildingScenario;
  onOpen: () => void;
  onLoadExample: () => void;
  onOpenDemo?: () => void;
  onTemplates?: () => void;
  onSettings?: () => void;
  onOpenTemplate?: (
    building: BuildingScenario,
    name: string,
    action: "edit" | "simulate",
  ) => void;
  online?: boolean;
  disabled?: boolean;
}

export function StudioWelcome({
  building,
  onOpen,
  onLoadExample,
  onOpenDemo,
  onTemplates,
  onSettings,
  onOpenTemplate,
  online = false,
  disabled = false,
}: StudioWelcomeProps) {
  const templatesHeading = useRef<HTMLHeadingElement>(null);
  function browseTemplates() {
    const heading = templatesHeading.current;
    if (!heading) {
      onTemplates?.();
      return;
    }
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "start",
    });
  }
  return (
    <section
      className={`studio-welcome${onOpenTemplate ? " has-templates" : ""}`}
      aria-label="Welcome to ExitZero Studio"
    >
      <header className="welcome-header">
        <div className="studio-brand">
          <span className="studio-symbol" aria-hidden="true">
            ↗
          </span>{" "}
          ExitZero <span>Studio</span>
        </div>
        <div className="welcome-header-actions">
          {onTemplates && (
            <button
              type="button"
              className="studio-control welcome-templates-action"
              onClick={onTemplates}
              title="Browse all templates and emergency scenarios"
            >
              Open Templates <span aria-hidden="true">↗</span>
            </button>
          )}
          {onSettings && (
            <button
              type="button"
              className="studio-control"
              aria-haspopup="dialog"
              aria-controls="studio-settings-dialog"
              onClick={onSettings}
            >
              Settings
            </button>
          )}
        </div>
      </header>
      <div className="welcome-composition">
        <div className="welcome-copy">
          <p className="welcome-kicker">BUILDING EVACUATION SIMULATOR</p>
          <h1>
            Design for
            <br />
            the unexpected<span>.</span>
          </h1>
          <p className="welcome-description">
            Design a floor plan. Run an evacuation. Examine the traffic.
          </p>
          <div className="welcome-actions">
            <button type="button" className="entry-action" onClick={onOpen}>
              {disabled ? "Return to Studio" : "Open Studio"}{" "}
              <span aria-hidden="true">↗</span>
            </button>
            {(onTemplates || onOpenTemplate) && (
              <button
                type="button"
                className="welcome-action-secondary"
                onClick={browseTemplates}
                aria-controls={onOpenTemplate ? "welcome-templates" : undefined}
              >
                Browse templates <span aria-hidden="true">↓</span>
              </button>
            )}
            <button
              type="button"
              className="welcome-action-tertiary"
              disabled={disabled}
              onClick={onLoadExample}
            >
              Load example building <span aria-hidden="true">→</span>
            </button>
          </div>
          <p className="welcome-footnote">
            2D simulation · Experimental prototype
          </p>
        </div>
        <div className="welcome-drawing">
          <WelcomePreview building={building} officeDemo={!!onOpenDemo} />
          {onOpenDemo ? (
            <div className="welcome-demo-link">
              <p>56 occupants · 2 exits · Editable office plan</p>
              <button
                type="button"
                className="welcome-example"
                disabled={disabled}
                onClick={onOpenDemo}
              >
                View office demo <span aria-hidden="true">→</span>
              </button>
              <span>Saved Rust simulation with recorded traffic.</span>
            </div>
          ) : (
            <p>Illustrative floor plan · No simulation running</p>
          )}
        </div>
      </div>
      {onOpenTemplate && (
        <section
          id="welcome-templates"
          className="welcome-templates"
          aria-labelledby="welcome-templates-heading"
        >
          <div className="welcome-templates-heading">
            <div>
              <h2
                id="welcome-templates-heading"
                ref={templatesHeading}
                tabIndex={-1}
              >
                Building templates
              </h2>
              <p>Click a floor plan to open it in the editor.</p>
            </div>
            {onTemplates && (
              <button
                type="button"
                className="studio-control"
                onClick={onTemplates}
              >
                View all templates <span aria-hidden="true">↗</span>
              </button>
            )}
          </div>
          <div className="template-gallery">
            {buildingPresets.map((preset) => (
              <TemplateCard
                key={preset.id}
                name={preset.label}
                building={preset.building}
                busy={disabled}
                online={online}
                onEdit={() =>
                  onOpenTemplate(preset.building, preset.label, "edit")
                }
                onRun={() =>
                  onOpenTemplate(preset.building, preset.label, "simulate")
                }
              />
            ))}
          </div>
        </section>
      )}
      <footer className="welcome-bottom">
        <span>© 2026 Kent Brogrammers</span>
        <a href={repositoryUrl} target="_blank" rel="noreferrer">
          GitHub <span aria-hidden="true">↗</span>
        </a>
      </footer>
    </section>
  );
}
