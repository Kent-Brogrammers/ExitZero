import type { BuildingScenario, TrafficSample } from "../types/simulation";

export interface OfficeTraffic {
  source: {
    recording: string;
    recording_sha256: string;
    building_sha256: string;
  };
  width: number;
  height: number;
  traffic_samples: TrafficSample[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A frontend-only, traffic-only derivative. Playback still loads recording.json. */
export async function loadOfficeTraffic(
  building: BuildingScenario,
  signal?: AbortSignal,
): Promise<OfficeTraffic> {
  const response = await fetch(
    new URL("./office-demo/traffic.json", import.meta.url),
    { signal },
  );
  if (!response.ok) throw new Error("Recorded office traffic is unavailable.");
  const data: unknown = await response.json();
  if (
    !record(data) ||
    data.width !== building.width ||
    data.height !== building.height ||
    !record(data.source) ||
    data.source.recording !== "recording.json" ||
    typeof data.source.recording_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.source.recording_sha256) ||
    !Array.isArray(data.traffic_samples) ||
    !data.traffic_samples.length ||
    !data.traffic_samples.every(
      (sample: unknown) =>
        record(sample) &&
        typeof sample.x === "number" &&
        Number.isFinite(sample.x) &&
        typeof sample.y === "number" &&
        Number.isFinite(sample.y) &&
        sample.x >= 0 &&
        sample.x <= building.width &&
        sample.y >= 0 &&
        sample.y <= building.height &&
        typeof sample.visits === "number" &&
        Number.isSafeInteger(sample.visits) &&
        sample.visits >= 0,
    ) ||
    !data.traffic_samples.some((sample: TrafficSample) => sample.visits > 0)
  )
    throw new Error("Recorded office traffic does not match this floor plan.");

  // Check the complete preset, not just its dimensions: another 36 × 24 m
  // building must never inherit unrelated office traffic.
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(building)),
  );
  const fingerprint = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (data.source.building_sha256 !== fingerprint)
    throw new Error("Recorded office traffic does not match this floor plan.");
  return data as unknown as OfficeTraffic;
}
