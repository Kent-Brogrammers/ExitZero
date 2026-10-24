import { useId, useState } from "react";
import {
  MAX_OBJECT_NAME_LENGTH,
  nameProblem,
  normalizeObjectName,
} from "./names";

interface ObjectNameFieldProps {
  name: string;
  onCommit: (name: string) => void;
}

/** Commit on Enter/blur, keeping invalid drafts out of the building and its history. */
export function ObjectNameField({ name, onCommit }: ObjectNameFieldProps) {
  const [draft, setDraft] = useState(name);
  const [problem, setProblem] = useState<string | null>(null);
  const hintId = useId();
  return (
    <div className="object-name-field">
      <label>
        Name
        <input
          type="text"
          value={draft}
          maxLength={MAX_OBJECT_NAME_LENGTH * 2}
          aria-describedby={hintId}
          aria-invalid={!!problem}
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(null);
          }}
          onBlur={() => {
            const error = nameProblem(draft);
            setProblem(error);
            if (error) return;
            const value = normalizeObjectName(draft);
            setDraft(value);
            if (value !== name) onCommit(value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              event.stopPropagation();
              setDraft(name);
              setProblem(null);
            }
          }}
        />
      </label>
      <p
        id={hintId}
        className={problem ? "name-error" : "name-hint"}
        role={problem ? "alert" : undefined}
      >
        {problem ??
          `${[...draft].length} / ${MAX_OBJECT_NAME_LENGTH} characters · Enter to save`}
      </p>
    </div>
  );
}
