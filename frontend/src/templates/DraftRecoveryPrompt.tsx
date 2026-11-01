import { useId } from "react";
import type { RecoveryDraft } from "./draftRecovery";
import "./DraftRecovery.css";

export function DraftRecoveryPrompt({
  draft,
  problem,
  disabled,
  onRestore,
  onDiscard,
}: {
  draft: RecoveryDraft | null;
  problem: string;
  disabled: boolean;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  const title = useId();
  return (
    <aside className="draft-recovery-prompt" aria-labelledby={title}>
      <h2 id={title}>
        {draft ? "Restore your draft?" : "Recovery copy needs attention"}
      </h2>
      {draft && (
        <p>
          {draft.sourceLayout
            ? `${draft.sourceLayout.name} · `
            : "Last editing session · "}
          <time dateTime={draft.updatedAt}>
            {new Date(draft.updatedAt).toLocaleString()}
          </time>
        </p>
      )}
      <p>
        {draft
          ? "A local copy of your unsaved layout is available. Choose Restore or Discard to resume automatic draft backup."
          : "The stored recovery copy is being preserved. Discard it only if you no longer need it."}
      </p>
      {problem && <p role="alert">{problem}</p>}
      <div className="draft-recovery-actions">
        <button
          type="button"
          className="studio-control"
          disabled={disabled}
          onClick={onDiscard}
        >
          Discard Draft
        </button>
        {draft && (
          <button
            type="button"
            className="studio-control draft-recovery-primary"
            disabled={disabled}
            onClick={onRestore}
          >
            Restore Draft
          </button>
        )}
      </div>
    </aside>
  );
}
