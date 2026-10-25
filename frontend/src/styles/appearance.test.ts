import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AppearanceSelector } from "./StudioAppearance";

it("describes the fixed black shell and blue floor plan without theme controls", () => {
  const html = renderToStaticMarkup(createElement(AppearanceSelector));
  expect(html).toContain("Black");
  expect(html).toContain("Blue blueprint");
  expect(html).not.toContain("<select");
  expect(html).not.toContain("Light");
});
