import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StudioAbout } from "./StudioAbout";

// Browser checks cover native disclosure toggling, focus, dismissal and sizing.
describe("About / project credits", () => {
  it("starts collapsed and identifies the project, team, event and repository", () => {
    const html = renderToStaticMarkup(<StudioAbout />);
    expect(html).toContain("<summary>About ExitZero</summary>");
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    for (const value of ["Kent Brogrammers", "2026", "Stark State Hackathon"])
      expect(html).toContain(value);
    expect(html).toContain(
      'href="https://github.com/Kent-Brogrammers/ExitZero"',
    );
    expect(html).toContain("Experimental simulation prototype");
    expect(html).toContain("Not a certified emergency planning tool");
  });
  it("credits all four contributors as project responsibilities without invented profile links", () => {
    const html = renderToStaticMarkup(<StudioAbout />);
    expect(html).toContain("Project responsibilities");
    for (const [name, area, contribution] of [
      [
        "Chris",
        "Frontend Engineering",
        "Building editor, workspace design, simulation visualization",
      ],
      [
        "Layth",
        "Frontend &amp; Data Visualization",
        "Analytics interface and integration",
      ],
      [
        "Connor",
        "Simulation Engineering",
        "Rust simulation, agent movement and navigation",
      ],
      [
        "Nick",
        "Analytics &amp; Optimization",
        "Stress testing, scenario evaluation and optimization",
      ],
    ]) {
      expect(html).toContain(`<strong>${name}</strong>`);
      expect(html).toContain(area);
      expect(html).toContain(contribution);
    }
    expect(html.match(/href=/g)).toHaveLength(1);
  });
});
