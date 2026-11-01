import { useEffect, useMemo, useRef, useState } from "react";
import type { BuildingScenario } from "../types/simulation";
import type { UserTemplate } from "./templates";
import {
  DRAFT_STORAGE_KEY,
  DRAFT_DELAY_MS,
  parseRecoveryDraft,
  saveRecoveryDraft,
  discardRecoveryDraft,
  checkRecoveryCopy,
  type RecoveryDraft,
} from "./draftRecovery";

function failure(reason: unknown) {
  if (reason instanceof SyntaxError)
    return "The recovery copy could not be read. It has been kept unchanged.";
  return reason instanceof Error
    ? reason.message
    : "Local draft recovery is unavailable. Save or export JSON to keep a backup.";
}
function initialRecovery() {
  let raw: string | null | undefined;
  try {
    raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    return {
      raw,
      draft: raw === null ? null : parseRecoveryDraft(raw),
      problem: "",
    };
  } catch (reason) {
    return { raw, draft: null, problem: failure(reason) };
  }
}

export function useDraftRecovery(
  building: BuildingScenario,
  savedJson: string,
  sourceLayout: UserTemplate | null,
) {
  const [initial] = useState(initialRecovery);
  const expected = useRef(initial.raw);
  const [pending, setPending] = useState(initial.raw != null);
  const [problem, setProblem] = useState(initial.problem);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const currentJson = useMemo(() => JSON.stringify(building), [building]);
  const dirty = currentJson !== savedJson;

  useEffect(() => {
    if (pending || problem || expected.current === undefined) return;
    if (!dirty) {
      if (expected.current !== null) {
        try {
          discardRecoveryDraft(window.localStorage, expected.current);
          expected.current = null;
          setLastSavedAt(null);
        } catch (reason) {
          setProblem(failure(reason));
        }
      }
      return;
    }
    let written = false;
    function flush() {
      if (written || expected.current === undefined) return;
      try {
        const saved = saveRecoveryDraft(
          window.localStorage,
          expected.current,
          building,
          sourceLayout,
        );
        expected.current = saved.raw;
        written = true;
        setLastSavedAt(saved.draft.updatedAt);
      } catch (reason) {
        setProblem(failure(reason));
      }
    }
    const timer = window.setTimeout(flush, DRAFT_DELAY_MS);
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [building, dirty, pending, problem, sourceLayout]);

  function restore(apply: (draft: RecoveryDraft) => boolean) {
    if (!initial.draft || expected.current === undefined) return;
    try {
      checkRecoveryCopy(window.localStorage, expected.current);
      if (apply(structuredClone(initial.draft))) {
        setPending(false);
        setProblem("");
        setLastSavedAt(initial.draft.updatedAt);
      }
    } catch (reason) {
      setProblem(failure(reason));
    }
  }
  function discard() {
    if (expected.current === undefined) return;
    try {
      discardRecoveryDraft(window.localStorage, expected.current);
      expected.current = null;
      setPending(false);
      setProblem("");
      setLastSavedAt(null);
    } catch (reason) {
      setProblem(failure(reason));
    }
  }
  return {
    pending,
    draft: initial.draft,
    problem,
    lastSavedAt,
    restore,
    discard,
  };
}
