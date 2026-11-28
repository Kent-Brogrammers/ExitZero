import type { BuildingScenario } from "../types/simulation";
import { buildingError } from "../editor/geometry";
import { withoutObjectNames } from "../editor/names";

// Frontend matching primitive for the proposed run format in docs/run-recordings.md.
// This is not an engine identity or a claim of cross-version repeatability.
export const INPUT_FINGERPRINT_VERSION = "exitzero-input-v1";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Stable request identity: retain array order and explicit defaults; omit display names. */
export function canonicalSimulationInput(building: BuildingScenario): string {
  const error = buildingError(building, false);
  if (error)
    throw new Error(`Cannot identify invalid simulation input: ${error}`);
  // Normalize optional undefined values exactly as the JSON API does. Work only
  // on copies; the saved input still retains the user's object/modifier names.
  const json = JSON.parse(JSON.stringify(withoutObjectNames(building))) as {
    [key: string]: Json;
  };
  for (const modifier of (json.agent_modifiers ?? []) as {
    [key: string]: Json;
  }[])
    delete modifier.name;
  return canonical(json);
}

/** Capture canonical bytes before the async digest so later editor changes cannot affect it. */
export async function simulationInputFingerprint(
  building: BuildingScenario,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${INPUT_FINGERPRINT_VERSION}\n${canonicalSimulationInput(building)}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${INPUT_FINGERPRINT_VERSION}:sha256:${hex}`;
}
