import type { BuildingScenario } from "../types/simulation";
import type { TracingAsset, TracingConfig, TracingReference } from "./tracing";

export const TRACING_DATABASE = "exitzero.tracing.v1";
const TRACING_HINT_KEY = "exitzero.tracing.used";
export function hasTracingReferences(): boolean {
  try {
    return window.localStorage.getItem(TRACING_HINT_KEY) === "1";
  } catch {
    return true;
  }
}
interface StoredAsset {
  id: string;
  name: string;
  blob: Blob;
}
interface Binding {
  key: string;
  assetId: string;
  config: TracingConfig;
}
export interface StoredTracing {
  asset: StoredAsset;
  config: TracingConfig;
}

export async function tracingLayoutKey(
  building: BuildingScenario,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(building)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("Local image storage is unavailable."));
      return;
    }
    const request = indexedDB.open(TRACING_DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("assets", { keyPath: "id" });
      db.createObjectStore("bindings", { keyPath: "key" }).createIndex(
        "assetId",
        "assetId",
      );
    };
    request.onerror = () => reject(request.error);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(
        new Error("Close other ExitZero tabs to enable local image storage."),
      );
    };
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

export async function readTracing(key: string): Promise<StoredTracing | null> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(["assets", "bindings"], "readonly");
      tx.onabort = tx.onerror = () => reject(tx.error);
      const binding = tx.objectStore("bindings").get(key);
      binding.onsuccess = () => {
        const value = binding.result as Binding | undefined;
        if (!value) {
          resolve(null);
          return;
        }
        const asset = tx.objectStore("assets").get(value.assetId);
        asset.onsuccess = () => {
          const stored = asset.result as StoredAsset | undefined;
          if (
            !stored ||
            !(stored.blob instanceof Blob) ||
            typeof stored.name !== "string" ||
            !value.config
          )
            reject(
              new Error(
                "The saved tracing image could not be read. Import the original image again.",
              ),
            );
          else resolve({ asset: stored, config: value.config });
        };
      };
    });
  } finally {
    db.close();
  }
}

/** A project with no image must not inherit an older reference for identical geometry. */
export async function clearTracing(key: string): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("bindings", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
      tx.objectStore("bindings").delete(key);
    });
  } finally {
    db.close();
  }
}

/** The binary is stored once; further edits write only a small layout binding. */
export async function writeTracing(
  key: string,
  reference: TracingReference,
): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["assets", "bindings"], "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
      const assets = tx.objectStore("assets"),
        exists = assets.getKey(reference.asset.id);
      exists.onsuccess = () => {
        if (exists.result === undefined) {
          const { id, name, blob } = reference.asset;
          assets.put({ id, name, blob } satisfies StoredAsset);
        }
        tx.objectStore("bindings").put({
          key,
          assetId: reference.asset.id,
          config: reference.config,
        } satisfies Binding);
      };
    });
    try {
      window.localStorage.setItem(TRACING_HINT_KEY, "1");
    } catch {
      /* IndexedDB remains authoritative. */
    }
  } finally {
    db.close();
  }
}

export async function removeTracing(
  asset: Pick<TracingAsset, "id">,
): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["assets", "bindings"], "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
      tx.objectStore("assets").delete(asset.id);
      const bindings = tx.objectStore("bindings"),
        cursor = bindings
          .index("assetId")
          .openKeyCursor(IDBKeyRange.only(asset.id));
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (item) {
          bindings.delete(item.primaryKey);
          item.continue();
        }
      };
    });
  } finally {
    db.close();
  }
}
