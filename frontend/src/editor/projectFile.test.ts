import { expect, it } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario } from "../types/simulation";
import { buildingError } from "./geometry";
import {
  parseProject,
  PROJECT_FILE_LIMIT,
  serializeProject,
} from "./projectFile";
import type { TracingReference } from "./tracing";

// A genuine 1×1 PNG; no generated evacuation results are used in these tests.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
function building(): BuildingScenario {
  return {
    ...structuredClone(example),
    blocked_exit_ids: ["west"],
    opening_events: [
      { step: 0, opening_id: "door_north", blocked: true },
      { step: 40, opening_id: "door_north", blocked: false },
    ],
    obstructions: [
      { id: "desk", name: "Reception", x: 18, y: 5, width: 2, height: 1 },
    ],
  };
}
function reference(): TracingReference {
  return {
    asset: {
      id: "reference",
      name: "office.png",
      url: "blob:source",
      image: {} as HTMLImageElement,
      blob: new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], {
        type: "image/png",
      }),
      width: 1,
      height: 1,
    },
    config: {
      width: 12,
      x: 1,
      y: 2,
      opacity: 0.4,
      visible: false,
      sizing: "custom",
    },
  };
}
const file = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { size: new Blob([text]).size, text: async () => text };
};
async function encoded() {
  return JSON.parse(
    await serializeProject(
      building(),
      reference(),
      new Map([["desk", "desk"]]),
    ),
  );
}

it("round-trips exact simulation settings, stable references, furniture symbols and image bytes", async () => {
  const source = building(),
    image = reference();
  const before = JSON.stringify(source);
  const result = await parseProject(
    file(
      await serializeProject(
        source,
        image,
        new Map([
          ["desk", "desk"],
          ["deleted", "chair"],
        ]),
      ),
    ),
  );
  expect(result.building).toEqual(source);
  expect(buildingError(result.building, false)).toBeNull();
  expect([...result.furniture]).toEqual([["desk", "desk"]]);
  expect(result.reference?.name).toBe("office.png");
  expect(result.reference?.config).toEqual(image.config);
  expect(result.reference?.blob.type).toBe("image/png");
  expect(await result.reference!.blob.arrayBuffer()).toEqual(
    await image.asset.blob.arrayBuffer(),
  );
  result.building.walls[0]!.name = "Edited copy";
  expect(JSON.stringify(source)).toBe(before);
  expect(image.asset.url).toBe("blob:source");
  expect(JSON.stringify(result.building)).not.toMatch(
    /data_base64|sha256|reference|furniture/,
  );
});
it("supports editable drafts without exits, occupants, images or furniture", async () => {
  const draft = {
    ...building(),
    walls: [],
    doors: [],
    exits: [],
    spawn_zones: [],
    blocked_exit_ids: [],
    opening_events: [],
    obstructions: [],
  };
  const result = await parseProject(
    file(await serializeProject(draft, null, new Map())),
  );
  expect(result.building).toEqual(draft);
  expect(result.reference).toBeUndefined();
  expect(result.furniture.size).toBe(0);
});
it("does not export an image name that its own reader cannot restore", async () => {
  const image = reference();
  image.asset.name = "x".repeat(201);
  await expect(serializeProject(building(), image, new Map())).rejects.toThrow(
    /Rename the reference image/,
  );
});
it("directs legacy building JSON to its existing import workflow", async () => {
  await expect(parseProject(file(building()))).rejects.toThrow(/Import JSON/);
});
it("rejects invalid JSON, oversized files and future versions before applying anything", async () => {
  await expect(parseProject(file("{"))).rejects.toThrow(/not a valid/);
  await expect(
    parseProject({ size: PROJECT_FILE_LIMIT + 1, text: async () => "" }),
  ).rejects.toThrow(/20 MB/);
  await expect(
    parseProject(file({ ...(await encoded()), version: 2 })),
  ).rejects.toThrow(/version is not supported/);
  await expect(
    parseProject(file({ ...(await encoded()), future: true })),
  ).rejects.toThrow(/unsupported fields/);
});
it("rejects broken wall references and invalid geometry instead of repairing a project silently", async () => {
  const value = await encoded();
  value.building.doors[0].wall_id = "missing-wall";
  await expect(parseProject(file(value))).rejects.toThrow();
  await expect(
    serializeProject({ ...building(), width: -1 }, null, new Map()),
  ).rejects.toThrow();
});
it.each(["missing", "duplicate", "unsupported"])(
  "rejects %s furniture references",
  async (kind) => {
    const value = await encoded();
    if (kind === "missing") value.furniture[0].id = "gone";
    else if (kind === "duplicate") value.furniture.push(value.furniture[0]);
    else value.furniture[0].kind = "new-physics";
    await expect(parseProject(file(value))).rejects.toThrow(/furniture/);
  },
);
it.each(["hash", "mime", "base64", "settings", "fields"])(
  "rejects damaged or incompatible image %s",
  async (kind) => {
    const value = await encoded();
    if (kind === "hash") value.reference.sha256 = "0".repeat(64);
    if (kind === "mime") value.reference.mime_type = "image/jpeg";
    if (kind === "base64") value.reference.data_base64 = "!!!!";
    if (kind === "settings") value.reference.settings.opacity = 2;
    if (kind === "fields") value.reference.settings.rotation = 45;
    await expect(parseProject(file(value))).rejects.toThrow();
  },
);
