import { useEffect, useRef, useState } from "react";
import type { BuildingScenario } from "../types/simulation";
import type { FurnitureKind } from "./furniture";
import {
  parseProject,
  serializeProject,
  type OpenedProject,
} from "./projectFile";
import {
  tracingConfigError,
  type TracingAsset,
  type TracingReference,
} from "./tracing";

interface ProjectFileOptions {
  building: BuildingScenario;
  reference: TracingReference | null;
  furniture: ReadonlyMap<string, FurnitureKind>;
  disabled: boolean;
  referenceProblem: string | null;
  loadImage: (blob: Blob, name: string) => Promise<TracingAsset>;
  releaseImage: (asset: TracingAsset) => void;
  onOpen: (
    project: OpenedProject,
    reference: TracingReference | null,
  ) => boolean;
  onSaved: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

export function useProjectFiles(options: ProjectFileOptions) {
  const latest = useRef(options);
  latest.current = options;
  const input = useRef<HTMLInputElement>(null),
    alive = useRef(true),
    running = useRef(false);
  const urls = useRef(new Set<string>());
  const timers = useRef(new Set<number>());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    alive.current = true;
    const owned = urls.current;
    const pending = timers.current;
    return () => {
      alive.current = false;
      for (const url of owned) URL.revokeObjectURL(url);
      owned.clear();
      for (const timer of pending) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);
  function current(source: ProjectFileOptions) {
    return (
      alive.current &&
      !latest.current.disabled &&
      latest.current.building === source.building &&
      latest.current.reference === source.reference &&
      latest.current.furniture === source.furniture
    );
  }
  function start() {
    if (running.current || latest.current.disabled) return null;
    running.current = true;
    setBusy(true);
    const source = latest.current;
    source.onError("");
    return source;
  }
  function finish() {
    running.current = false;
    if (alive.current) setBusy(false);
    if (input.current) input.current.value = "";
  }
  function failed(reason: unknown) {
    if (!alive.current) return;
    latest.current.onNotice("");
    latest.current.onError(
      reason instanceof Error
        ? reason.message
        : "Could not open or save the project. Your current drawing is unchanged.",
    );
  }
  async function save() {
    const source = start();
    if (!source) return;
    try {
      if (source.referenceProblem) throw new Error(source.referenceProblem);
      source.onNotice("Preparing project download…");
      const text = await serializeProject(
        source.building,
        source.reference,
        source.furniture,
      );
      if (!current(source))
        throw new Error(
          "The layout or image changed while saving. Save Project again to include your latest changes.",
        );
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/json" }),
      );
      urls.current.add(url);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = "exitzero-project.exitzero";
        link.click();
      } catch (reason) {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
        throw reason;
      }
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
        timers.current.delete(timer);
      }, 1000);
      timers.current.add(timer);
      source.onSaved();
      source.onNotice(
        "Project downloaded with its layout, emergency setup, and reference image if present.",
      );
    } catch (reason) {
      failed(reason);
    } finally {
      finish();
    }
  }
  async function open(file?: File) {
    if (!file) return;
    const source = start();
    if (!source) return;
    let asset: TracingAsset | undefined;
    try {
      source.onNotice("Checking project…");
      const project = await parseProject(file);
      let reference: TracingReference | null = null;
      if (project.reference) {
        asset = await source.loadImage(
          project.reference.blob,
          project.reference.name,
        );
        const problem = tracingConfigError(asset, project.reference.config);
        if (problem) throw new Error(problem);
        reference = { asset, config: project.reference.config };
      }
      if (!current(source))
        throw new Error(
          "The layout or image changed while opening this file. Open Project again when you are ready.",
        );
      if (!source.onOpen(project, reference)) {
        source.onNotice("");
        return;
      }
      asset = undefined;
      source.onNotice(
        "Project opened. Its original browser saves are unchanged.",
      );
    } catch (reason) {
      failed(reason);
    } finally {
      if (asset) source.releaseImage(asset);
      finish();
    }
  }
  return { input, busy, save, open };
}
