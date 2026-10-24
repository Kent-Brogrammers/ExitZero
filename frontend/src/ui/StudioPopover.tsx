import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface StudioPopoverProps {
  label: string;
  children: (close: () => void) => ReactNode;
  indicator?: ReactNode;
  className?: string;
  disabled?: boolean;
}

/** A small disclosure: normal Tab navigation, outside-click and Escape dismissal. */
export function StudioPopover({
  label,
  children,
  indicator,
  className = "",
  disabled = false,
}: StudioPopoverProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [right, setRight] = useState(0);
  const id = useId();
  const visible = open && !disabled;
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!visible) return;
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const width = panel.current?.offsetWidth;
      if (!anchor || !width) return;
      // Keep the disclosure anchored to its trigger while respecting viewport edges.
      const edge = Math.min(
        window.innerWidth - 12,
        Math.max(width + 12, anchor.right),
      );
      setRight(anchor.right - edge);
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [visible]);

  return (
    <div
      ref={root}
      className={`studio-popover ${className}`}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="studio-control"
        disabled={disabled}
        aria-expanded={visible}
        aria-controls={visible ? id : undefined}
        onClick={() => setOpen(!visible)}
      >
        {label}
        {indicator ?? (
          <span className="control-caret" aria-hidden="true">
            ⌄
          </span>
        )}
      </button>
      {visible && (
        <div
          id={id}
          ref={panel}
          style={{ right }}
          className="studio-popover-panel"
          role="region"
          aria-label={`${label} options`}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}
