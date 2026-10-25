import type { ReactNode } from "react";
import type { BuildingScenario, WindowFrameState } from "../types/simulation";
import { WindowReadout } from "./WindowReadout";

/** Secondary readouts stay off the Canvas and out of the main metric row. */
export function SimulationDetails({
  building,
  states,
  children,
}: {
  building: BuildingScenario;
  states?: readonly WindowFrameState[];
  children: ReactNode;
}) {
  return (
    <details className="simulation-details">
      <summary className="studio-control">Details</summary>
      <div className="simulation-details-popover">
        <WindowReadout building={building} states={states} />
        {children}
      </div>
    </details>
  );
}
