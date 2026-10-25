import type { Opening, Wall } from "../types/simulation";
import { openingSegment } from "./geometry";

/** Drawing convention only: a wide opening remains one unchanged walkable gap. */
export function doorLeaves(opening: Opening, wall: Wall) {
  const [a, b] = openingSegment(opening, wall);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const hinges = opening.width >= 1.6 ? [a, b] : [a];
  const radius = opening.width / hinges.length;
  return hinges.map((hinge, index) => ({
    hinge,
    tip: {
      x: hinge.x - Math.sin(angle) * radius,
      y: hinge.y + Math.cos(angle) * radius,
    },
    radius,
    startAngle: angle + index * Math.PI,
    endAngle: angle + Math.PI / 2,
    counterclockwise: index === 1,
  }));
}
