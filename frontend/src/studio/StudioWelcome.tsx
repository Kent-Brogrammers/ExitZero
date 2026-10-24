import { useEffect, useRef } from "react";
import type { BuildingScenario } from "../types/simulation";
import { drawLayout } from "../editor/draw";
import { useStudioTheme } from "../styles/appearance";
import "./StudioWelcome.css";

interface StudioWelcomeProps {
  building: BuildingScenario;
  onOpen: () => void;
  onLoadExample: () => void;
  onOpenDemo?: () => void;
  disabled?: boolean;
}

export function StudioWelcome({
  building,
  onOpen,
  onLoadExample,
  onOpenDemo,
  disabled = false,
}: StudioWelcomeProps) {
  const theme = useStudioTheme();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const redraw = () =>
      drawLayout(element, building, null, undefined, window.devicePixelRatio);
    const observer = new ResizeObserver(redraw);
    observer.observe(element);
    window.addEventListener("resize", redraw);
    redraw();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", redraw);
    };
  }, [building, theme]);

  return (
    <section className="studio-welcome" aria-label="Welcome to ExitZero Studio">
      <header className="welcome-header">
        <div className="studio-brand">
          <span className="studio-symbol" aria-hidden="true">
            ↗
          </span>{" "}
          ExitZero <span>Studio</span>
        </div>
        <span className="welcome-edition">A space to explore the way out.</span>
      </header>
      <div className="welcome-composition">
        <div className="welcome-copy">
          <p className="welcome-kicker">SPACE. PEOPLE. POSSIBILITY.</p>
          <h1>
            Design for
            <br />
            the unexpected<span>.</span>
          </h1>
          <p className="welcome-description">
            Shape a floor plan. Explore an evacuation. See where a better way
            out begins.
          </p>
          <div className="welcome-actions">
            <button className="entry-action" onClick={onOpen}>
              Open Studio <span aria-hidden="true">↗</span>
            </button>
            <button
              className="welcome-example"
              disabled={disabled}
              onClick={onLoadExample}
            >
              Load example building <span aria-hidden="true">→</span>
            </button>
          </div>
          <p className="welcome-footnote">
            Continuous 2D geometry · An exploratory engineering prototype
          </p>
        </div>
        <div className="welcome-drawing">
          <div className="welcome-drawing-heading">
            <span>
              {onOpenDemo ? "OFFICE DEMO / 01" : "THE FLOOR PLAN / 01"}
            </span>
            <span>
              {building.width} × {building.height} M
            </span>
          </div>
          <canvas
            data-world-canvas
            ref={canvas}
            width={900}
            height={720}
            role="img"
            aria-label={
              onOpenDemo
                ? "Office demo floor plan with open workspace, meeting room, corridor, break room and two exits. No simulation is running."
                : "Illustrative example building floor plan. No simulation is running."
            }
          />
          <div className="welcome-scan" aria-hidden="true" />
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
              <span>Includes a saved Rust run and real recorded traffic.</span>
            </div>
          ) : (
            <p>Illustrative floor plan · No simulation running</p>
          )}
        </div>
      </div>
      <div className="welcome-bottom">
        <span>ExitZero Studio / Local prototype</span>
        <span>Design · Simulate · Understand</span>
      </div>
    </section>
  );
}
