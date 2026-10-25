import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import asset from "./office-demo/traffic.json";
import recording from "./office-demo/recording.json";
import { officeDemoBuilding } from "./officeDemo";
import { loadOfficeTraffic } from "./officeTraffic";
import { WelcomePreview } from "./WelcomePreview";

afterEach(() => vi.unstubAllGlobals());
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

describe("recorded office welcome traffic", () => {
  it("preserves the exact samples and identifies the verified recording and complete preset", () => {
    expect(asset.traffic_samples).toEqual(recording.traffic_samples);
    expect(asset.width).toBe(recording.width);
    expect(asset.height).toBe(recording.height);
    expect(asset.source.recording).toBe("recording.json");
    expect(asset.source.recording_sha256).toBe(
      sha256(
        readFileSync(new URL("./office-demo/recording.json", import.meta.url)),
      ),
    );
    expect(asset.source.building_sha256).toBe(
      sha256(JSON.stringify(officeDemoBuilding)),
    );
    expect("frames" in asset).toBe(false);
    expect("analytics" in asset).toBe(false);
    expect(JSON.stringify(asset).length).toBeLessThan(
      JSON.stringify(recording).length / 5,
    );
  });

  it("loads only the traffic asset with cancellation support", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(asset));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const result = await loadOfficeTraffic(
      officeDemoBuilding,
      controller.signal,
    );
    expect(result.traffic_samples).toEqual(recording.traffic_samples);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toMatch(
      /office-demo\/traffic\.json$/,
    );
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), {
      signal: controller.signal,
    });
  });

  it.each([
    null,
    { ...asset, width: asset.width + 1 },
    { ...asset, source: { ...asset.source, recording_sha256: "invalid" } },
    { ...asset, source: { ...asset.source, building_sha256: "0".repeat(64) } },
    { ...asset, traffic_samples: [] },
    { ...asset, traffic_samples: [{ x: 1, y: 1, visits: 0 }] },
    { ...asset, traffic_samples: [{ x: asset.width + 1, y: 1, visits: 1 }] },
    { ...asset, traffic_samples: [{ x: 1, y: 1, visits: -1 }] },
    { ...asset, traffic_samples: [{ x: 1, y: 1, visits: 1.5 }] },
    { ...asset, traffic_samples: [{ x: "1", y: 1, visits: 1 }] },
  ])(
    "rejects missing, malformed, stale or empty traffic instead of fabricating a preview (%#)",
    async (invalid) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(invalid)),
      );
      await expect(loadOfficeTraffic(officeDemoBuilding)).rejects.toThrow(
        /traffic/,
      );
    },
  );

  it("rejects another building even if its dimensions are identical", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(asset)),
    );
    const other = structuredClone(officeDemoBuilding);
    other.walls[0]!.start.x += 0.5;
    await expect(loadOfficeTraffic(other)).rejects.toThrow(/does not match/);
  });

  it("handles missing and malformed asset responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );
    await expect(loadOfficeTraffic(officeDemoBuilding)).rejects.toThrow(
      /unavailable/,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid JSON")),
    );
    await expect(loadOfficeTraffic(officeDemoBuilding)).rejects.toThrow();
  });

  it("provides accessible view controls, one dimension caption and a useful floor plan while loading", () => {
    const html = renderToStaticMarkup(
      <WelcomePreview building={officeDemoBuilding} officeDemo />,
    );
    expect(html).toContain('aria-label="Office preview visualization"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Floor Plan/);
    expect(html).toMatch(/disabled=""[^>]*>Traffic Heatmap/);
    expect(html).toContain("Loading recorded traffic");
    expect(html.match(/36 × 24 m/g)).toHaveLength(1);
    const ordinary = renderToStaticMarkup(
      <WelcomePreview building={officeDemoBuilding} officeDemo={false} />,
    );
    expect(ordinary).toContain("1 m grid");
    expect(ordinary).not.toContain("Traffic Heatmap");
  });
});
