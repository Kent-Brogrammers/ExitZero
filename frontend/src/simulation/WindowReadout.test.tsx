import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WindowReadout } from "./WindowReadout";
import { syntheticBuilding } from "./playback.fixture";

it("shows actual window queue state and clearly marks missing state instead of inventing counts", () => {
  const building = {
    ...syntheticBuilding,
    windows: [
      {
        id: "pane",
        name: "East window",
        wall_id: syntheticBuilding.walls[0]!.id,
        offset: 2,
        width: 2,
      },
    ],
  };
  expect(renderToStaticMarkup(<WindowReadout building={building} />)).toContain(
    "unavailable",
  );
  expect(
    renderToStaticMarkup(<WindowReadout building={syntheticBuilding} />),
  ).toBe("");
  const html = renderToStaticMarkup(
    <WindowReadout
      building={building}
      states={[
        {
          window_id: "pane",
          state: "broken",
          preparation_ready_step: 10,
          queue_agent_ids: [1, 2],
          traversing_agent_id: 3,
          traversal_earliest_finish_step: 30,
        },
      ]}
    />,
  );
  expect(html).toContain("2 waiting");
  expect(html).toContain("1 traversing");
  expect(html).toContain("East window");
  expect(html).toContain("broken");
});

it("shows authoritative rejection reasons and distinguishes people approaching from those waiting", () => {
  const html = renderToStaticMarkup(
    <WindowReadout
      building={syntheticBuilding}
      states={[
        {
          window_id: "pane",
          state: "intact",
          preparation_ready_step: null,
          queue_agent_ids: [],
          traversing_agent_id: null,
          traversal_earliest_finish_step: null,
          approaching_agent_ids: [1, 2],
          unavailable_reason:
            "No route to the configured indoor approach. Check the exterior direction.",
        },
      ]}
    />,
  );
  expect(html).toContain("2 approaching");
  expect(html).toContain("0 waiting");
  expect(html).toContain("1 unavailable");
  expect(html).toContain("Check the exterior direction");
  expect(html).toContain('open=""');
});
