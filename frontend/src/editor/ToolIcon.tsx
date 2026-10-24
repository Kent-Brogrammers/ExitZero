const paths: Record<string, string> = {
  select: "M5 3l14 9-7 1-3 7-4-17z M13 14l5 6",
  wall: "M4 18L20 6 M4 12l6 6 M14 6l6 6",
  door: "M5 20V4h14v16 M9 20V7l8-3v16 M13 13h1",
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
