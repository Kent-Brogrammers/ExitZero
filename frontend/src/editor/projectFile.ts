import type { BuildingScenario } from "../types/simulation";
import { buildingError } from "./geometry";
import { furniturePresets, type FurnitureKind } from "./furniture";
import {
  TRACING_FILE_LIMIT,
  tracingConfigError,
  type TracingConfig,
  type TracingReference,
} from "./tracing";

export const PROJECT_FILE_LIMIT = 20 * 1024 * 1024;
const BUILDING_LIMIT = 2_000_000;
interface ProjectReference {
  name: string;
  mime_type: "image/png" | "image/jpeg";
  sha256: string;
  data_base64: string;
  settings: TracingConfig;
}
export interface ProjectFile {
  format: "exitzero-project";
  version: 1;
  building: BuildingScenario;
  furniture: { id: string; kind: FurnitureKind }[];
  reference?: ProjectReference;
}
export interface OpenedProject {
  building: BuildingScenario;
  furniture: Map<string, FurnitureKind>;
  reference?: { name: string; blob: Blob; config: TracingConfig };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(
      "This project contains unsupported fields. Open it with a compatible ExitZero version.",
    );
}
function checkBuilding(value: unknown): asserts value is BuildingScenario {
  const error = buildingError(value, false);
  if (error) throw new Error(error);
  if (new Blob([JSON.stringify(value)]).size > BUILDING_LIMIT)
    throw new Error(
      "The building inside this project exceeds the 2 MB layout limit.",
    );
}
function imageMime(bytes: Uint8Array): "image/png" | "image/jpeg" {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  throw new Error("The project reference must contain a PNG or JPEG image.");
}
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
}
function encode(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
function decode(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > Math.ceil(TRACING_FILE_LIMIT / 3) * 4 ||
    value.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error(
      "The project reference has invalid or oversized image data.",
    );
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("The project reference has invalid image data.");
  }
  if (binary.length > TRACING_FILE_LIMIT)
    throw new Error("The project image exceeds 10 MB.");
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
function checkSettings(value: unknown): asserts value is TracingConfig {
  if (!record(value))
    throw new Error("The project reference is missing its image settings.");
  fields(value, ["width", "x", "y", "opacity", "visible", "sizing"]);
  if (
    ![value.width, value.x, value.y, value.opacity].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    ) ||
    (value.width as number) <= 0 ||
    (value.width as number) > 1000 ||
    (value.x as number) < 0 ||
    (value.y as number) < 0 ||
    (value.opacity as number) < 0.05 ||
    (value.opacity as number) > 0.8 ||
    typeof value.visible !== "boolean" ||
    !["fitted", "custom"].includes(value.sizing as string)
  )
    throw new Error(
      "The project reference has invalid image size, position, or opacity.",
    );
}

/** A frontend file envelope. Only building is ever sent to the simulation API. */
export async function serializeProject(
  building: BuildingScenario,
  reference: TracingReference | null,
  furniture: ReadonlyMap<string, FurnitureKind>,
): Promise<string> {
  const copy = structuredClone(building);
  checkBuilding(copy);
  const project: ProjectFile = {
    format: "exitzero-project",
    version: 1,
    building: copy,
    furniture: [...furniture]
      .filter(([id]) => copy.obstructions.some((o) => o.id === id))
      .map(([id, kind]) => ({ id, kind })),
  };
  if (reference) {
    if (!reference.asset.name.trim() || reference.asset.name.length > 200)
      throw new Error(
        "Rename the reference image to 1–200 characters before saving this project.",
      );
    const bytes = new Uint8Array(await reference.asset.blob.arrayBuffer());
    if (!bytes.length || bytes.length > TRACING_FILE_LIMIT)
      throw new Error("Choose a project image up to 10 MB.");
    checkSettings(reference.config);
    const problem = tracingConfigError(reference.asset, reference.config);
    if (problem) throw new Error(problem);
    project.reference = {
      name: reference.asset.name,
      mime_type: imageMime(bytes),
      sha256: await digest(bytes),
      data_base64: encode(bytes),
      settings: { ...reference.config },
    };
  }
  const text = JSON.stringify(project) + "\n";
  if (new Blob([text]).size > PROJECT_FILE_LIMIT)
    throw new Error("This project exceeds the 20 MB file limit.");
  return text;
}

/** Decode and validate before the editor changes any geometry or reference state. */
export async function parseProject(
  file: Pick<File, "size" | "text">,
): Promise<OpenedProject> {
  if (!file.size || file.size > PROJECT_FILE_LIMIT)
    throw new Error("Choose an ExitZero project file up to 20 MB.");
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new Error("This is not a valid ExitZero project file.");
  }
  if (!record(value) || value.format !== "exitzero-project")
    throw new Error(
      "Choose an ExitZero project. Use Import JSON for a building-only JSON file.",
    );
  if (value.version !== 1)
    throw new Error(
      "This project version is not supported. Your current drawing is unchanged.",
    );
  fields(value, ["format", "version", "building", "furniture", "reference"]);
  checkBuilding(value.building);
  if (
    !Array.isArray(value.furniture) ||
    value.furniture.length > value.building.obstructions.length
  )
    throw new Error("The project has invalid furniture drawing styles.");
  const furniture = new Map<string, FurnitureKind>();
  for (const item of value.furniture) {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      typeof item.kind !== "string" ||
      !Object.hasOwn(furniturePresets, item.kind) ||
      furniture.has(item.id) ||
      !value.building.obstructions.some((o) => o.id === item.id)
    )
      throw new Error(
        "A project furniture style has an invalid or missing object reference.",
      );
    fields(item, ["id", "kind"]);
    furniture.set(item.id, item.kind as FurnitureKind);
  }
  const project: OpenedProject = { building: value.building, furniture };
  if ("reference" in value) {
    const r = value.reference;
    if (!record(r))
      throw new Error("The project reference is missing or invalid.");
    fields(r, ["name", "mime_type", "sha256", "data_base64", "settings"]);
    if (
      typeof r.name !== "string" ||
      !r.name.trim() ||
      r.name.length > 200 ||
      typeof r.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(r.sha256)
    )
      throw new Error(
        "The project reference is missing its name or integrity information.",
      );
    checkSettings(r.settings);
    const bytes = decode(r.data_base64);
    const mime = imageMime(bytes);
    if (mime !== r.mime_type || (await digest(bytes)) !== r.sha256)
      throw new Error(
        "The project image is damaged or does not match its saved integrity information.",
      );
    project.reference = {
      name: r.name,
      blob: new Blob([bytes], { type: mime }),
      config: r.settings,
    };
  }
  return project;
}
