import { useEffect, useId, useRef, useState } from "react";
import "./RoomFillDialog.css";

export function RoomFillDialog({
  initialCount,
  existingCount,
  onFill,
  onClose,
}: {
  initialCount: number;
  existingCount: number;
  onFill: (count: number) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [count, setCount] = useState(String(initialCount));
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
      className="room-fill-dialog"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const r = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < r.left ||
          event.clientX > r.right ||
          event.clientY < r.top ||
          event.clientY > r.bottom
        )
          onClose();
      }}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          try {
            onFill(Number(count));
            onClose();
          } catch (reason) {
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not populate this room.",
            );
          }
        }}
      >
        <div className="control-popover-heading">
          <h2 id={id}>Fill Room</h2>
          <button
            type="button"
            className="studio-control studio-control--icon"
            aria-label="Close room fill"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p>
          Fill the room with one spawn polygon beneath furniture and objects.
          Occupants are placed in clear floor space; walls define the room edges.
        </p>
        {existingCount > 0 && (
          <p className="room-fill-replace">
            Replace this room’s {existingCount} existing{" "}
            {existingCount === 1 ? "occupant" : "occupants"}. Other rooms stay
            unchanged. Undo restores the previous areas.
          </p>
        )}
        <label>
          Occupants
          <input
            type="number"
            min={1}
            max={10000}
            step={1}
            autoFocus
            value={count}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setCount(event.target.value);
              setError("");
            }}
            aria-invalid={!!error}
            aria-describedby={`${id}-help`}
          />
        </label>
        <p id={`${id}-help`}>
          Rust randomly places occupants with body clearance using the
          simulation seed. Edit the room total later in Properties.
        </p>
        {error && (
          <p className="room-fill-error" role="alert">
            {error}
          </p>
        )}
        <div className="room-fill-actions">
          <button type="button" className="studio-control" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="studio-control room-fill-apply">
            Fill Room
          </button>
        </div>
      </form>
    </dialog>
  );
}
