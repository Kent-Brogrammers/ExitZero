import "./StudioKeybinds.css";

const groups = [
  {
    title: "Editor actions",
    bindings: [
      ["Undo", "Ctrl/Cmd+Z"],
      ["Redo", "Ctrl/Cmd+Shift+Z"],
      ["Rotate object 90°", "R"],
      ["Duplicate selection", "Ctrl/Cmd+D"],
      ["Delete selection", "Delete / Backspace"],
      ["Cancel or dismiss", "Esc"],
    ],
    note: "Duplicate copies selected elements or groups; walls carry their openings. R rotates one furniture/object. Escape cancels drawing, closes Properties, or clears selection; expanded view exits first.",
  },
  {
    title: "Drawing & navigation",
    bindings: [
      ["Lock wall angle", "Shift + drag"],
      ["Square / circle", "Shift + drag"],
      ["Add/remove selection", "Shift + click"],
      ["One curve segment", "Alt + click"],
      ["Open Properties", "Double-click"],
      ["Pan Canvas", "Space + drag"],
      ["Zoom in", "+ or ="],
      ["Zoom out", "−"],
      ["Fit plan", "0"],
    ],
    note: "Shift locks straight walls to horizontal, vertical or 45°; rectangle/ellipse tools constrain to a square/circle. Scroll also zooms; middle/right-drag also pans.",
  },
  {
    title: "Recorded playback",
    bindings: [
      ["Play / pause", "Space"],
      ["Previous / next frame", "← / →"],
      ["First / last frame", "Home / End"],
    ],
    note: "For completed recordings. Frame stepping and seeking pause playback.",
  },
] as const;

export function StudioKeybinds() {
  return (
    <div className="studio-keybinds">
      <div className="studio-keybinds-content">
        <p className="studio-keybinds-note">
          Focus the editor or playback Canvas to use its shortcuts. Text fields
          keep normal typing. Cmd is ⌘ on Mac; use Ctrl on Windows/Linux.
        </p>
        {groups.map(({ title, bindings, note }) => (
          <section key={title} aria-label={title}>
            <h4>{title}</h4>
            <ul>
              {bindings.map(([label, keys]) => (
                <li key={label}>
                  <span>{label}</span>
                  <kbd>{keys}</kbd>
                </li>
              ))}
            </ul>
            <p className="studio-keybinds-note">{note}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
