import { useEffect, useRef } from "react";
import type { BuildingScenario } from "../types/simulation";
import { drawLayout } from "../editor/draw";
import "./StudioWelcome.css";

interface StudioWelcomeProps {
  building: BuildingScenario;
  onOpen: () => void;
  onLoadExample: () => void;
  disabled?: boolean;
}

export function StudioWelcome({
  building,
  onOpen,
  onLoadExample,
  disabled = false,
}: StudioWelcomeProps) {
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
  }, [building]);

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
            <span>THE FLOOR PLAN / 01</span>
            <span>
              {building.width} × {building.height} M
            </span>
          </div>
          <canvas
            ref={canvas}
            width={900}
            height={720}
            role="img"
            aria-label="Illustrative example building floor plan. No simulation is running."
          />
          <div className="welcome-scan" aria-hidden="true" />
          <p>Illustrative floor plan · No simulation running</p>
        </div>
      </div>
      <div className="welcome-bottom">
        <span>ExitZero Studio / Local prototype</span>
        <span>Design · Simulate · Understand</span>
      </div>
    </section>
  );
}
