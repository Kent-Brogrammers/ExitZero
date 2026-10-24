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
  side?: "below" | "left" | "right";
  triggerContent?: ReactNode;
  triggerClassName?: string;
  onOpen?: () => void;
}

/** A small disclosure: normal Tab navigation, outside-click and Escape dismissal. */
export function StudioPopover({
  label,
  children,
  indicator,
  className = "",
  disabled = false,
  side = "below",
  triggerContent,
  triggerClassName = "",
  onOpen,
}: StudioPopoverProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ right: 0, top: 0 });
  const id = useId();
  const visible = open && !disabled;
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const width = panel.current?.offsetWidth;
      const height = panel.current?.offsetHeight;
      if (!anchor || !width || !height) return;
      const besideLeft = side === "left" && anchor.left >= width + 20;
      const besideRight =
        side === "right" && anchor.right + width + 20 <= window.innerWidth;
      const beside = besideLeft || besideRight;
      const desiredRight = besideLeft
        ? anchor.left - 8
        : besideRight
          ? anchor.right + width + 8
          : anchor.right;
      const edge = Math.min(
        window.innerWidth - 12,
        Math.max(width + 12, desiredRight),
      );
      const top = Math.max(
        12,
        Math.min(
          beside ? anchor.top : anchor.bottom + 8,
          window.innerHeight - height - 12,
        ),
      );
      setPosition({ right: anchor.right - edge, top: top - anchor.top });
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [visible, side]);

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
        className={`studio-control ${triggerClassName}`}
        disabled={disabled}
        aria-label={label}
        aria-expanded={visible}
        aria-controls={visible ? id : undefined}
        onClick={() => {
          if (!visible) onOpen?.();
          setOpen(!visible);
        }}
      >
        {triggerContent ?? label}
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
          style={position}
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
