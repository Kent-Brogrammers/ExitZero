const paths: Record<string, string> = {
  desk: "M3 5h18v14H3z M16 5v14 M16 10h5 M16 14h5",
  table: "M3 5h18v14H3z M5 7l2 2 M19 7l-2 2 M5 17l2-2 M19 17l-2-2",
  cabinet: "M4 4h16v16H4z M12 4v16 M9 10v4 M15 10v4",
  bookshelf: "M3 5h18v14H3z M8 5v14 M16 5v14 M3 9h18 M3 15h18",
  bench: "M3 5h18v14H3z M3 9h18 M7 9v10 M12 9v10 M17 9v10",
  chair: "M6 3h12v8H6z M4 11h16v7H4z M6 18v3 M18 18v3",
  curve: "M3 18C8 3 10 4 12 12s5 9 9-7",
  grid: "M4 4h16v16H4z M4 10h16 M4 16h16 M10 4v16 M16 4v16",
  undo: "M9 4L4 9l5 5 M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 4l5 5-5 5 M20 9H10a6 6 0 0 0 0 12h3",
  file: "M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h6",
  rectangle: "M3 6h18v12H3z",
  square: "M4 4h16v16H4z",
  circle: "M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0",
  stairs: "M3 20h6v-5h5v-5h5V4 M3 4l17 17",
  properties: "M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6",
  select: "M5 3l14 9-7 1-3 7-4-17z M13 14l5 6",
  wall: "M4 18L20 6 M4 12l6 6 M14 6l6 6",
  door: "M5 20V4h14v16 M9 20V7l8-3v16 M13 13h1",
  window: "M3 5h18v14H3z M3 9h18 M3 15h18 M12 5v14",
  exit: "M10 4H4v16h6 M10 12h11 M16 7l5 5-5 5",
  spawn:
    "M8 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M2 20v-3a5 5 0 0 1 10 0v3 M17 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4 M15 14a4 4 0 0 1 6 3v3",
  obstruction: "M4 4h16v16H4z M8 8l8 8 M16 8l-8 8",
};

export function ToolIcon({ name }: { name: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
