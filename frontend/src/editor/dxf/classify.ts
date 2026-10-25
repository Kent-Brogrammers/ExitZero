import type { BuildingScenario, Point } from "../../types/simulation";
import type {
  DxfDrawing,
  ImportOptions,
  OpeningCandidate,
  OpeningChoice,
} from "./convert";
export interface OpeningGuess {
  role: Exclude<OpeningChoice, "review">;
  reason: string;
  confidence: "high" | "medium" | "uncertain";
}
const length = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
/** Suggestions use source layer semantics plus nearby geometry, never certify outdoors. */
export function classifyOpenings(
  drawing: DxfDrawing,
  options: ImportOptions,
  building: BuildingScenario,
  openings: OpeningCandidate[],
): Record<string, OpeningGuess> {
  const selected = drawing.strokes
    .filter((s) => options.layers.includes(s.layer))
    .filter(
      (s) =>
        !options.crop ||
        [s.start, s.end].every(
          (p) =>
            p.x >= options.crop!.minX &&
            p.x <= options.crop!.maxX &&
            p.y >= options.crop!.minY &&
            p.y <= options.crop!.maxY,
        ),
    );
  if (!selected.length) return {};
  const minX = Math.min(...selected.flatMap((s) => [s.start.x, s.end.x])),
    maxY = Math.max(...selected.flatMap((s) => [s.start.y, s.end.y]));
  const world = (p: Point) => ({
    x: (p.x - minX) * options.scale + 1,
    y: (maxY - p.y) * options.scale + 1,
  });
  const source = drawing.strokes
    .filter((s) =>
      /door|porte|puerta|exit|egress|emergency|window|glaz/i.test(
        s.layer.split(" · ")[0]!,
      ),
    )
    .map((s) => ({ ...s, start: world(s.start), end: world(s.end) }));
  return Object.fromEntries(
    openings.map((opening) => {
      const wall = building.walls.find((w) => w.id === opening.wall_id)!;
      const l = length(wall.start, wall.end),
        ux = (wall.end.x - wall.start.x) / l,
        uy = (wall.end.y - wall.start.y) / l;
      const at = (offset: number) => ({
        x: wall.start.x + ux * offset,
        y: wall.start.y + uy * offset,
      });
      const a = at(opening.offset),
        b = at(opening.offset + opening.width);
      const evidence = source.filter((s) => {
        const d = length(s.start, s.end);
        if (d < 0.05) return false;
        const project = (p: Point) => (p.x - a.x) * ux + (p.y - a.y) * uy;
        const normal = (p: Point) =>
          Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux);
        const p = project(s.start),
          q = project(s.end);
        const overlap = Math.max(
          0,
          Math.min(opening.width, Math.max(p, q)) - Math.max(0, Math.min(p, q)),
        );
        const parallel =
          Math.abs(
            ((s.end.x - s.start.x) * ux + (s.end.y - s.start.y) * uy) / d,
          ) > 0.95;
        const across =
          parallel &&
          normal(s.start) < Math.max(0.25, wall.thickness) &&
          normal(s.end) < Math.max(0.25, wall.thickness) &&
          overlap > opening.width * 0.55;
        const hinge =
          Math.min(
            length(s.start, a),
            length(s.start, b),
            length(s.end, a),
            length(s.end, b),
          ) < 0.22 &&
          d >= opening.width * 0.65 &&
          d <= opening.width * 1.35;
        return across || hinge;
      });
      const has = (pattern: RegExp) =>
        evidence.some((s) => pattern.test(s.layer.split(" · ")[0]!));
      const window = has(/window|glaz/i),
        door = has(/door|porte|puerta/i),
        exit = has(/exit|egress|emergency/i);
      let guess: OpeningGuess;
      if (window && (door || exit))
        guess = {
          role: "closed",
          confidence: "uncertain",
          reason:
            "Conflicting door/window evidence; sealed until you override it.",
        };
      else if (window)
        guess = {
          role: "closed",
          confidence: "high",
          reason:
            "Nearby window/glazing layer geometry; keep solid for evacuation.",
        };
      else if (exit)
        guess = {
          role: "exit",
          confidence: "high",
          reason:
            "Nearby geometry is explicitly on an EXIT/EGRESS layer; verify its designation.",
        };
      else if (door) {
        const near = (v: number, t: number) => Math.abs(v - t) < 0.25;
        const exterior =
          (near(wall.start.x, 1) && near(wall.end.x, 1)) ||
          (near(wall.start.x, building.width - 1) &&
            near(wall.end.x, building.width - 1)) ||
          (near(wall.start.y, 1) && near(wall.end.y, 1)) ||
          (near(wall.start.y, building.height - 1) &&
            near(wall.end.y, building.height - 1));
        guess = exterior
          ? {
              role: "exit",
              confidence: "medium",
              reason:
                "Door geometry on the outer plan extent: suggested exit. This does not prove it leads outdoors.",
            }
          : {
              role: "door",
              confidence: "high",
              reason: "Matching nearby DOORS-layer geometry.",
            };
      } else
        guess = {
          role: "closed",
          confidence: "uncertain",
          reason:
            "No reliable door/exit evidence. Gap is sealed; change it if it is a passage.",
        };
      return [opening.id, guess];
    }),
  );
}
export function blankManualLayout(base: BuildingScenario): BuildingScenario {
  return {
    ...base,
    width: 30,
    height: 20,
    walls: [],
    doors: [],
    exits: [],
    spawn_zones: [],
    blocked_exit_ids: [],
    obstructions: [],
    stair_areas: [],
  };
}
