import { useEffect, useId, useRef, useState } from "react";
import { templateName } from "./templates";
import "./Saving.css";

export function LayoutNameDialog({
  title,
  initialName,
  action,
  onConfirm,
  onClose,
}: {
  title: string;
  initialName: string;
  action: string;
  onConfirm: (name: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState("");
  useEffect(() => {
    const target = dialog.current;
    const previous = document.activeElement;
    target?.showModal();
    return () => {
      target?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="layout-name-dialog"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          try {
            onConfirm(templateName(name));
            onClose();
          } catch (reason) {
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not save. Export JSON to keep a portable backup.",
            );
          }
        }}
      >
        <h2 id={id}>{title}</h2>
        <p>Stored only in this browser. Export JSON for a portable backup.</p>
        <label>
          Layout name
          <input
            autoFocus
            value={name}
            maxLength={80}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
          />
        </label>
        {error && (
          <p role="alert" id={`${id}-error`}>
            {error}
          </p>
        )}
        <div className="layout-dialog-actions">
          <button type="button" className="studio-control" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="studio-control layout-confirm">
            {action}
          </button>
        </div>
      </form>
    </dialog>
  );
}
