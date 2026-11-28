import { useCallback, useEffect, useRef, useState } from "react";
import type { BuildingScenario } from "../types/simulation";
import {
  loadTracingAsset,
  restoreTracingConfig,
  tracingConfigError,
  type TracingAsset,
  type TracingReference,
} from "./tracing";
import {
  hasTracingReferences,
  clearTracing,
  readTracing,
  removeTracing,
  tracingLayoutKey,
  writeTracing,
} from "./tracingStorage";

export function useTracingReference(building: BuildingScenario) {
  const [reference, setReference] = useState<TracingReference | null>(null);
  const [storageMessage, setStorageMessage] = useState("");
  const [storageProblem, setStorageProblem] = useState(false);
  const [settledFor, setSettledFor] = useState<BuildingScenario | null>(null);
  const managed = useRef(false);
  const current = useRef(reference),
    alive = useRef(true);
  const assets = useRef(new Set<TracingAsset>()),
    skipRestore = useRef<BuildingScenario | null>(null);
  const writes = useRef<Promise<unknown>>(Promise.resolve()),
    epoch = useRef(0);
  current.current = reference;
  const queue = useCallback((task: () => Promise<void>) => {
    const next = writes.current.catch(() => {}).then(task);
    writes.current = next;
    return next;
  }, []);
  function dispose(asset: TracingAsset) {
    URL.revokeObjectURL(asset.url);
    assets.current.delete(asset);
  }
  function update(next: TracingReference | null) {
    managed.current = true;
    epoch.current++;
    const previous = current.current;
    current.current = next;
    setReference(next);
    if (previous && previous.asset !== next?.asset) dispose(previous.asset);
    if (next) {
      setStorageMessage("Saving reference locally…");
      setStorageProblem(false);
    }
  }
  async function load(file: Blob, name: string, id?: string) {
    const asset = await loadTracingAsset(file, name, id);
    if (!alive.current) {
      URL.revokeObjectURL(asset.url);
      throw new DOMException("Image loading cancelled", "AbortError");
    }
    assets.current.add(asset);
    return asset;
  }
  function release(asset: TracingAsset) {
    if (current.current?.asset !== asset) dispose(asset);
  }
  const storageFailed = useCallback((reason: unknown) => {
    if (!alive.current) return;
    setStorageMessage(
      `${reason instanceof Error ? reason.message : "Local image storage failed."} The reference is available in this tab; keep the original image file.`,
    );
    setStorageProblem(true);
  }, []);

  useEffect(() => {
    alive.current = true;
    const owned = assets.current;
    return () => {
      alive.current = false;
      for (const asset of owned) URL.revokeObjectURL(asset.url);
      owned.clear();
    };
  }, []);
  useEffect(() => {
    if (
      reference ||
      managed.current ||
      skipRestore.current === building ||
      !hasTracingReferences()
    )
      return;
    let cancelled = false;
    void (async () => {
      const stored = await readTracing(await tracingLayoutKey(building));
      if (cancelled || current.current || managed.current) return;
      if (!stored) {
        setSettledFor(building);
        return;
      }
      const asset = await loadTracingAsset(
        stored.asset.blob,
        stored.asset.name,
        stored.asset.id,
      );
      if (cancelled || !alive.current || current.current || managed.current) {
        URL.revokeObjectURL(asset.url);
        return;
      }
      const config = restoreTracingConfig(asset, stored.config);
      const problem = tracingConfigError(asset, config);
      if (problem) {
        URL.revokeObjectURL(asset.url);
        throw new Error(problem);
      }
      assets.current.add(asset);
      const restored = { asset, config };
      current.current = restored;
      setReference(restored);
      setStorageMessage("Reference restored from this browser.");
    })().catch((reason) => {
      if (!cancelled) {
        setSettledFor(building);
        storageFailed(reason);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [building, reference, storageFailed]);
  useEffect(() => {
    if (!reference) return;
    let cancelled = false;
    const revision = epoch.current;
    const timer = window.setTimeout(() => {
      void tracingLayoutKey(building)
        .then((key) => {
          if (cancelled || revision !== epoch.current) return;
          return queue(() => writeTracing(key, reference)).then(() => {
            if (!cancelled && alive.current) {
              setStorageMessage("Reference saved in this browser.");
              setStorageProblem(false);
            }
          });
        })
        .catch((reason) => {
          if (!cancelled) storageFailed(reason);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [building, reference, queue, storageFailed]);

  function remove() {
    const previous = current.current;
    skipRestore.current = building;
    update(null);
    if (previous)
      void queue(() => removeTracing(previous.asset))
        .then(() => {
          if (alive.current) {
            setStorageMessage("");
            setStorageProblem(false);
          }
        })
        .catch(storageFailed);
  }
  /** A different imported plan must never inherit the current plan's image. */
  function detach() {
    skipRestore.current = null;
    update(null);
    managed.current = false;
    setStorageMessage("");
    setStorageProblem(false);
  }
  function replaceFor(target: BuildingScenario, next: TracingReference | null) {
    update(next);
    skipRestore.current = target;
    if (!next) {
      setStorageMessage("");
      setStorageProblem(false);
      if (hasTracingReferences())
        void tracingLayoutKey(target)
          .then((key) => queue(() => clearTracing(key)))
          .catch(storageFailed);
    }
  }
  const ready =
    !!reference ||
    managed.current ||
    !hasTracingReferences() ||
    settledFor === building;
  return {
    reference,
    update,
    remove,
    detach,
    load,
    release,
    replaceFor,
    exportProblem: !ready
      ? "The saved tracing image is still loading. Try Save Project again in a moment."
      : !reference && !managed.current && storageProblem
        ? "The saved tracing image could not be read. Restore or remove it before saving a complete project."
        : null,
    storageMessage,
    storageProblem,
  };
}
