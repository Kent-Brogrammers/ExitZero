// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import type { BuildingScenario, Point } from "../types/simulation";
import { BuildingEditor } from "./BuildingEditor";
import { DRAFTING_STORAGE_KEY } from "./drafting";
import { canvasView } from "./geometry";
import { spawnContains } from "./spawnGeometry";

vi.mock("./draw", () => ({ drawLayout: vi.fn() }));

it.each([
  { source: "a loaded wall-thickness junction", drawDivider: false },
  { source: "a newly drawn and snapped divider", drawDivider: true },
])(
  "fills only the selected room after adding a door to $source",
  async ({ drawDivider }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const savedDrafting = localStorage.getItem(DRAFTING_STORAGE_KEY);
    localStorage.removeItem(DRAFTING_STORAGE_KEY);
    const perimeter: Point[] = [
      { x: 1, y: 1 },
      { x: 13, y: 1 },
      { x: 13, y: 11 },
      { x: 1, y: 11 },
    ];
    const initial: BuildingScenario = {
      ...structuredClone(example),
      width: 14,
      height: 12,
      walls: [
        ...perimeter.map((start, i) => ({
          id: `perimeter-${i}`,
          start,
          end: perimeter[(i + 1) % perimeter.length]!,
          thickness: 0.2,
        })),
        ...(drawDivider
          ? []
          : [
              {
                id: "custom-divider",
                // These wall bodies meet even though their centrelines miss by 3 cm.
                start: { x: 7, y: 1.03 },
                end: { x: 7, y: 11 },
                thickness: 0.2,
              },
            ]),
      ],
      doors: [],
      exits: [],
      blocked_exit_ids: [],
      obstructions: [],
      spawn_zones: [
        { id: "left-spawn", x: 2, y: 2, width: 2, height: 2, count: 5 },
        { id: "right-spawn", x: 9, y: 2, width: 2, height: 2, count: 3 },
      ],
    };
    let latest = initial;
    function Editor() {
      const [building, setBuilding] = useState(initial);
      return (
        <BuildingEditor
          building={building}
          onChange={(next) => {
            latest = next;
            setBuilding(next);
          }}
        />
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    async function click(label: string) {
      const button = host.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      );
      expect(button).not.toBeNull();
      await act(async () => button!.click());
    }
    try {
      await act(async () => root.render(<Editor />));
      const canvas = host.querySelector("canvas")!;
      canvas.width = 800;
      canvas.height = 600;
      canvas.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      canvas.setPointerCapture = vi.fn();
      canvas.releasePointerCapture = vi.fn();
      canvas.hasPointerCapture = vi.fn(() => false);
      const view = canvasView(
        800,
        600,
        initial,
        {
          zoom: 1,
          pan: { x: 0, y: 0 },
          extent: { width: initial.width, height: initial.height },
        },
        window.devicePixelRatio,
      );
      async function point(
        x: number,
        y: number,
        type: "pointerdown" | "pointerup" = "pointerdown",
      ) {
        await act(async () =>
          canvas.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              button: 0,
              pointerId: 1,
              clientX: view.x + x * view.scale,
              clientY: view.y + y * view.scale,
            }),
          ),
        );
      }

      if (drawDivider) {
        await click("Walls");
        await click("Straight wall");
        await point(7, 1.03);
        await point(7, 10.97, "pointerup");
        expect(latest.walls).toHaveLength(5);
        const divider = latest.walls.at(-1)!;
        expect(divider.start.x).toBeCloseTo(7, 8);
        expect(divider.start.y).toBeCloseTo(1, 8);
        expect(divider.end.x).toBeCloseTo(7, 8);
        expect(divider.end.y).toBeCloseTo(11, 8);
      }
      const wallsBeforeDoor = structuredClone(latest.walls);
      const dividerId = latest.walls.at(-1)!.id;
      await click("Openings");
      await click("Door");
      await point(7, 6);
      expect(latest.doors).toHaveLength(1);
      expect(latest.doors[0]!.wall_id).toBe(dividerId);
      expect(latest.exits).toHaveLength(0);
      expect(latest.walls).toEqual(wallsBeforeDoor);

      await click("People");
      await click("Fill Room");
      await point(3, 6);
      const dialog = host.querySelector<HTMLDialogElement>(".room-fill-dialog");
      expect(dialog?.open).toBe(true);
      expect(
        dialog!.querySelector<HTMLInputElement>('input[type="number"]')!.value,
      ).toBe("5");
      await act(async () =>
        dialog!
          .querySelector<HTMLButtonElement>('button[type="submit"]')!
          .click(),
      );

      expect(host.querySelector(".room-fill-dialog")).toBeNull();
      expect(latest.spawn_zones).toHaveLength(2);
      expect(
        latest.spawn_zones.find((zone) => zone.id === "right-spawn"),
      ).toEqual(initial.spawn_zones[1]);
      expect(latest.spawn_zones.some((zone) => zone.id === "left-spawn")).toBe(
        false,
      );
      const filled = latest.spawn_zones.find((zone) => zone.polygon)!;
      expect(filled).toBeDefined();
      expect(filled.count).toBe(5);
      expect(spawnContains(filled, { x: 3, y: 6 })).toBe(true);
      expect(spawnContains(filled, { x: 10, y: 6 })).toBe(false);
      expect(latest.doors).toHaveLength(1);
      expect(latest.exits).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      if (savedDrafting === null) localStorage.removeItem(DRAFTING_STORAGE_KEY);
      else localStorage.setItem(DRAFTING_STORAGE_KEY, savedDrafting);
      vi.unstubAllGlobals();
    }
  },
);
