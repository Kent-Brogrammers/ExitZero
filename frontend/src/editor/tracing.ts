import type { Bounds } from "./selection";

export interface TracingAsset {
  id: string;
  name: string;
  blob: Blob;
  image: HTMLImageElement;
  url: string;
  width: number;
  height: number;
}
export interface TracingConfig {
  /** World metres; the original aspect ratio determines height. */
  width: number;
  x: number;
  y: number;
  opacity: number;
  visible: boolean;
  sizing: "fitted" | "custom";
}
export interface TracingReference {
  asset: TracingAsset;
  config: TracingConfig;
}

export const TRACING_FILE_LIMIT = 10 * 1024 * 1024;
export function tracingBounds(
  asset: Pick<TracingAsset, "width" | "height">,
  config: TracingConfig,
): Bounds {
  return {
    x: config.x,
    y: config.y,
    width: config.width,
    height: (asset.height * config.width) / asset.width,
  };
}
export function fitTracingConfig(
  asset: Pick<TracingAsset, "width" | "height">,
  area: { width: number; height: number },
): TracingConfig {
  return {
    width: Math.min(area.width, (area.height * asset.width) / asset.height),
    x: 0,
    y: 0,
    opacity: 0.3,
    visible: true,
    sizing: "fitted",
  };
}

/** Preserve references saved by the earlier two-point setup. */
export function restoreTracingConfig(
  asset: Pick<TracingAsset, "width" | "height">,
  stored:
    | TracingConfig
    | {
        a: { x: number; y: number };
        b: { x: number; y: number };
        distance: number;
        x: number;
        y: number;
        opacity: number;
        visible: boolean;
      },
): TracingConfig {
  if ("width" in stored) return stored;
  const pixels =
    stored.a && stored.b
      ? Math.hypot(stored.a.x - stored.b.x, stored.a.y - stored.b.y)
      : 0;
  return {
    width: (asset.width * stored.distance) / pixels,
    x: stored.x,
    y: stored.y,
    opacity: stored.opacity,
    visible: stored.visible,
    sizing: "custom",
  };
}
export function tracingConfigError(
  asset: Pick<TracingAsset, "width" | "height">,
  config: TracingConfig,
): string | null {
  if (
    ![config.width, config.x, config.y, config.opacity].every(Number.isFinite)
  )
    return "Enter a valid image width and position.";
  if (config.width <= 0) return "Image width must be greater than zero.";
  const bounds = tracingBounds(asset, config);
  if (
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.x + bounds.width > 1000 ||
    bounds.y + bounds.height > 1000
  )
    return "The image must fit within the supported drawing extents. Check its width and position.";
  if (
    config.opacity < 0.05 ||
    config.opacity > 0.8 ||
    typeof config.visible !== "boolean" ||
    !["fitted", "custom"].includes(config.sizing)
  )
    return "Choose an opacity from 5% to 80%.";
  return null;
}

/** A reference image is a drafting aid; it never becomes building geometry or API data. */
export function drawTracingReference(
  ctx: CanvasRenderingContext2D,
  reference: TracingReference,
) {
  if (!reference.config.visible) return;
  const bounds = tracingBounds(reference.asset, reference.config);
  ctx.save();
  ctx.globalAlpha = reference.config.opacity;
  ctx.drawImage(
    reference.asset.image,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
  );
  ctx.restore();
}

export async function loadTracingAsset(
  blob: Blob,
  name: string,
  id: string = crypto.randomUUID(),
): Promise<TracingAsset> {
  if (!blob.size || blob.size > TRACING_FILE_LIMIT)
    throw new Error("Choose a PNG or JPEG image up to 10 MB.");
  const bytes = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every(
    (byte, i) => bytes[i] === byte,
  );
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg)
    throw new Error(
      "Choose a PNG or JPEG image. PDF and SVG files are not supported here.",
    );
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(
          new Error(
            "This image could not be opened. Try exporting a fresh PNG or JPEG.",
          ),
        );
      image.src = url;
    });
    const width = image.naturalWidth,
      height = image.naturalHeight;
    if (
      !width ||
      !height ||
      width > 8192 ||
      height > 8192 ||
      width * height > 20_000_000
    )
      throw new Error(
        "Use an image up to 20 megapixels and 8,192 pixels per side.",
      );
    return { id, name: name.slice(0, 200), blob, image, url, width, height };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
