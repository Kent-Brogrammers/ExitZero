import { expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import {
  drawTracingReference,
  fitTracingConfig,
  loadTracingAsset,
  restoreTracingConfig,
  tracingBounds,
  tracingConfigError,
  TRACING_FILE_LIMIT,
  type TracingConfig,
  type TracingReference,
} from "./tracing";
import { tracingLayoutKey } from "./tracingStorage";

const asset = { width: 1200, height: 800 };
const config = (): TracingConfig => ({
  width: 12,
  x: 1.5,
  y: 2.25,
  opacity: 0.3,
  visible: true,
  sizing: "custom",
});

it("fits an image immediately without asking for points or a measurement", () => {
  const fitted = fitTracingConfig(asset, { width: 30, height: 15 });
  expect(fitted).toEqual({
    width: 22.5,
    x: 0,
    y: 0,
    opacity: 0.3,
    visible: true,
    sizing: "fitted",
  });
  expect(tracingBounds(asset, fitted)).toEqual({
    x: 0,
    y: 0,
    width: 22.5,
    height: 15,
  });
  expect(tracingConfigError(asset, fitted)).toBeNull();
});
it("preserves image proportions in portrait and landscape workspaces", () => {
  for (const area of [
    { width: 10, height: 30 },
    { width: 40, height: 10 },
  ]) {
    const bounds = tracingBounds(asset, fitTracingConfig(asset, area));
    expect(bounds.width).toBeLessThanOrEqual(area.width);
    expect(bounds.height).toBeLessThanOrEqual(area.height);
    expect(bounds.width / bounds.height).toBe(1.5);
  }
});
it("changes image size without altering building geometry", () => {
  const before = JSON.stringify(example);
  expect(tracingBounds(asset, config())).toEqual({
    x: 1.5,
    y: 2.25,
    width: 12,
    height: 8,
  });
  expect(JSON.stringify(example)).toBe(before);
});
it("keeps previously stored two-point references at exactly their old scale", () => {
  const restored = restoreTracingConfig(asset, {
    a: { x: 100, y: 100 },
    b: { x: 400, y: 500 },
    distance: 5,
    x: 2,
    y: 3,
    opacity: 0.3,
    visible: false,
  });
  expect(restored).toEqual({
    width: 12,
    x: 2,
    y: 3,
    opacity: 0.3,
    visible: false,
    sizing: "custom",
  });
  expect(tracingBounds(asset, restored)).toEqual({
    x: 2,
    y: 3,
    width: 12,
    height: 8,
  });
  expect(restoreTracingConfig(asset, restored)).toBe(restored);
});
it.each([
  { width: 0 },
  { width: NaN },
  { width: Infinity },
  { x: -1 },
  { opacity: 0 },
  { width: 999, x: 2 },
  { visible: "true" },
  { sizing: "measured" },
])("rejects invalid image settings %j", (patch) => {
  expect(
    tracingConfigError(asset, { ...config(), ...patch } as TracingConfig),
  ).not.toBeNull();
});
it("draws the background in world coordinates and honors hidden references", () => {
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    drawImage: vi.fn(),
    globalAlpha: 1,
  };
  const reference = {
    asset: { ...asset, image: {} },
    config: config(),
  } as TracingReference;
  drawTracingReference(ctx as unknown as CanvasRenderingContext2D, reference);
  expect(ctx.drawImage).toHaveBeenCalledWith(
    reference.asset.image,
    1.5,
    2.25,
    12,
    8,
  );
  expect(ctx.save).toHaveBeenCalledOnce();
  expect(ctx.restore).toHaveBeenCalledOnce();
  drawTracingReference(ctx as unknown as CanvasRenderingContext2D, {
    ...reference,
    config: { ...reference.config, visible: false },
  });
  expect(ctx.drawImage).toHaveBeenCalledOnce();
});
it("rejects empty, oversized and disguised non-image files before decoding", async () => {
  await expect(loadTracingAsset(new Blob([]), "empty.png")).rejects.toThrow(
    /10 MB/,
  );
  await expect(
    loadTracingAsset(
      new Blob([new Uint8Array(TRACING_FILE_LIMIT + 1)]),
      "huge.png",
    ),
  ).rejects.toThrow(/10 MB/);
  await expect(
    loadTracingAsset(
      new Blob(["<svg></svg>"], { type: "image/png" }),
      "pretend.png",
    ),
  ).rejects.toThrow(/PNG or JPEG/);
});
it("only restores a background for the matching building, including JSON round-trips", async () => {
  const key = await tracingLayoutKey(example);
  expect(key).toBe(await tracingLayoutKey(JSON.parse(JSON.stringify(example))));
  expect(key).not.toBe(
    await tracingLayoutKey({ ...example, width: example.width + 1 }),
  );
});
