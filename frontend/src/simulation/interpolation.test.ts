import { describe, expect, it } from "vitest";
import type { AnimationFrame, BuildingScenario } from "../types/simulation";
import { syntheticBuilding } from "./playback.fixture";
import { createFrameSampler } from "./interpolation";

const empty: BuildingScenario = {
  ...syntheticBuilding,
  width: 10,
  height: 10,
  walls: [],
  doors: [],
  exits: [],
  spawn_zones: [],
  obstructions: [],
};
const frames: AnimationFrame[] = [
  {
    step: 5,
    agents: [
      { id: 7, x: 1, y: 1 },
      { id: 8, x: 5, y: 4 },
    ],
  },
  {
    step: 15,
    agents: [
      { id: 8, x: 7, y: 4 },
      { id: 7, x: 3, y: 1 },
    ],
  },
];
const barrier: BuildingScenario = {
  ...empty,
  walls: [
    {
      id: "partition",
      start: { x: 2, y: 0 },
      end: { x: 2, y: 5 },
      thickness: 0.2,
    },
  ],
};

describe("visual-only frame interpolation", () => {
  it("seeks actual window state and never blends through intact glazing", () => {
    const building: BuildingScenario = {
      ...barrier,
      windows: [{ id: "pane", wall_id: "partition", offset: 1, width: 2 }],
    };
    const intact: AnimationFrame = {
      step: 0,
      agents: [{ id: 1, x: 1, y: 2 }],
      window_states: [
        {
          window_id: "pane",
          state: "intact",
          preparation_ready_step: null,
          queue_agent_ids: [],
          traversing_agent_id: null,
          traversal_earliest_finish_step: null,
        },
      ],
    };
    const opened: AnimationFrame = {
      step: 10,
      agents: [{ id: 1, x: 3, y: 2 }],
      window_states: [
        {
          ...intact.window_states![0]!,
          state: "open",
          preparation_ready_step: 10,
          traversing_agent_id: 1,
          traversal_earliest_finish_step: 20,
        },
      ],
    };
    const sample = createFrameSampler(building, [intact, opened], 0.1);
    expect(sample(0.5)?.agents[0]!.x).toBe(1);
    expect(sample(0.5)?.window_states).toEqual(intact.window_states);
    expect(sample(1)?.window_states).toEqual(opened.window_states);
    expect(sample(0)?.window_states).toEqual(intact.window_states);
    const across = createFrameSampler(
      building,
      [
        { ...opened, step: 0, agents: intact.agents },
        { ...opened, step: 10 },
      ],
      0.1,
    );
    expect(across(0.5)?.agents[0]!.x).toBe(2);
  });
  it("respects rounded jamb clearance while interpolating through an opening", () => {
    const building = {
      ...empty,
      agent_radius: 0.2,
      walls: [
        {
          id: "wall",
          start: { x: 0, y: 2 },
          end: { x: 10, y: 2 },
          thickness: 0.2,
        },
      ],
      doors: [{ id: "door", wall_id: "wall", offset: 4.65, width: 0.7 }],
    };
    const passage = [
      { step: 0, agents: [{ id: 1, x: 5, y: 1 }] },
      { step: 10, agents: [{ id: 1, x: 5, y: 3 }] },
    ];
    expect(createFrameSampler(building, passage, 0.1)(0.5)?.agents[0]).toEqual({
      id: 1,
      x: 5,
      y: 2,
    });
    const tooNarrow = {
      ...building,
      doors: [{ ...building.doors[0]!, offset: 4.75, width: 0.5 }],
    };
    expect(createFrameSampler(tooNarrow, passage, 0.1)(0.5)?.agents[0]).toEqual(
      { id: 1, x: 5, y: 1 },
    );
    expect(
      createFrameSampler({ ...building, doors: [] }, passage, 0.1)(0.5)
        ?.agents[0],
    ).toEqual({ id: 1, x: 5, y: 1 });
  });
  it("matches stable IDs across reordered arrays and uses nonconsecutive step timestamps", () => {
    const sample = createFrameSampler(empty, frames, 0.2);
    expect(sample(2)?.agents).toEqual([
      { id: 7, x: 2, y: 1 },
      { id: 8, x: 6, y: 4 },
    ]);
    expect(sample(1.5)?.agents[0]?.x).toBeCloseTo(1.5);
  });
  it("never extrapolates and returns exact recorded positions at frame boundaries", () => {
    const sample = createFrameSampler(empty, frames, 0.2);
    expect(sample(-100)).toBe(frames[0]);
    expect(sample(1)).toBe(frames[0]);
    expect(sample(3)).toBe(frames[1]);
    expect(sample(100)).toBe(frames[1]);
  });
  it("holds disappearing agents until the next sample and introduces new agents only at their recorded sample", () => {
    const sample = createFrameSampler(
      empty,
      [frames[0]!, { step: 15, agents: [{ id: 9, x: 4, y: 2 }] }],
      0.2,
    );
    expect(sample(2)?.agents).toEqual(frames[0]!.agents);
    expect(sample(3)?.agents).toEqual([{ id: 9, x: 4, y: 2 }]);
  });
  it("keeps all original frames and positions untouched", () => {
    const original = structuredClone(frames);
    const frozen = frames.map((frame) =>
      Object.freeze({
        ...frame,
        agents: frame.agents.map((agent) => Object.freeze({ ...agent })),
      }),
    );
    const sample = createFrameSampler(empty, frozen, 0.2);
    sample(1.2);
    sample(2.4);
    sample(1.4);
    expect(frozen).toEqual(original);
    expect(frames).toEqual(original);
  });
  it("holds a position rather than blending through a solid wall", () => {
    const sample = createFrameSampler(barrier, frames, 0.2);
    expect(sample(2)?.agents[0]).toEqual(frames[0]!.agents[0]);
    expect(sample(3)?.agents[1]).toEqual(frames[1]!.agents[1]);
  });
  it("accounts for angled walls, wall thickness and occupant radius", () => {
    const building = {
      ...barrier,
      walls: [
        {
          ...barrier.walls[0]!,
          start: { x: 0, y: 0 },
          end: { x: 4, y: 4 },
          thickness: 0.5,
        },
      ],
    };
    expect(createFrameSampler(building, frames, 0.2)(2)?.agents[0]).toEqual(
      frames[0]!.agents[0],
    );
    const parallel = [
      { step: 0, agents: [{ id: 1, x: 2.1, y: 1 }] },
      { step: 10, agents: [{ id: 1, x: 2.1, y: 3 }] },
    ];
    expect(createFrameSampler(barrier, parallel, 0.1)(0.5)?.agents[0]?.y).toBe(
      1,
    );
  });
  it("allows blending through a sufficiently wide door opening", () => {
    const building = {
      ...barrier,
      doors: [{ id: "door", wall_id: "partition", offset: 0.5, width: 1 }],
    };
    expect(createFrameSampler(building, frames, 0.2)(2)?.agents[0]?.x).toBe(2);
  });
  it("treats blocked exits as solid and respects opening clearance", () => {
    const exit = { id: "exit", wall_id: "partition", offset: 0.5, width: 1 };
    expect(
      createFrameSampler({ ...barrier, exits: [exit] }, frames, 0.2)(2)
        ?.agents[0]?.x,
    ).toBe(2);
    expect(
      createFrameSampler(
        { ...barrier, exits: [exit], blocked_exit_ids: [exit.id] },
        frames,
        0.2,
      )(2)?.agents[0]?.x,
    ).toBe(1);
    expect(
      createFrameSampler(
        { ...barrier, doors: [{ ...exit, offset: 0.9, width: 0.2 }] },
        frames,
        0.2,
      )(2)?.agents[0]?.x,
    ).toBe(1);
  });
  it("holds paths crossing obstructions without inventing a detour", () => {
    const building = {
      ...empty,
      obstructions: [{ id: "desk", x: 1.8, y: 0.8, width: 0.4, height: 0.4 }],
    };
    expect(createFrameSampler(building, frames, 0.2)(2)?.agents[0]?.x).toBe(1);
    expect(createFrameSampler(building, frames, 0.2)(2)?.agents[1]?.x).toBe(6);
  });
  it("handles empty/single recordings and reuses the per-pair display buffer", () => {
    expect(createFrameSampler(empty, [], 0.1)(10)).toBeNull();
    expect(createFrameSampler(empty, [frames[0]!], 0.2)(100)).toBe(frames[0]);
    const sample = createFrameSampler(empty, frames, 0.2);
    const first = sample(1.5);
    expect(sample(2)).toBe(first);
    expect(sample(1.5)).toBe(first);
  });
});

it("smooths only received hazard positions and growth while keeping recordings immutable", () => {
  const building: BuildingScenario = {
    ...empty,
    disaster: { kind: "fire", center: { x: 2, y: 2 }, radius: 1 },
  };
  const recorded: AnimationFrame[] = [
    {
      step: 0,
      agents: [],
      disaster_state: {
        kind: "fire",
        areas: [{ id: 0, revision: 0, center: { x: 2, y: 2 }, radius: 1 }],
      },
    },
    {
      step: 10,
      agents: [],
      disaster_state: {
        kind: "fire",
        areas: [
          { id: 0, revision: 10, center: { x: 4, y: 2 }, radius: 2 },
          { id: 1, revision: 10, center: { x: 5, y: 3 }, radius: 0.2 },
        ],
      },
    },
  ];
  const original = structuredClone(recorded);
  const sample = createFrameSampler(building, recorded, 0.1);
  const midpoint = sample(0.5)!.disaster_state!;
  expect(midpoint.areas).toHaveLength(1);
  expect(midpoint.areas[0]!.center).toEqual({ x: 3, y: 2 });
  expect(midpoint.areas[0]!.radius).toBe(1.5);
  expect(sample(1)!.disaster_state!.areas).toHaveLength(2);
  expect(recorded).toEqual(original);
});

it("does not interpolate a tornado through a protected shelter between coarse samples", () => {
  const building: BuildingScenario = {
    ...empty,
    disaster: { kind: "tornado", center: { x: 1, y: 5 }, radius: 0.5 },
    tornado_zones: [{ id: "safe", x: 4, y: 4, width: 2, height: 2 }],
  };
  const recorded: AnimationFrame[] = [
    {
      step: 0,
      agents: [],
      disaster_state: {
        kind: "tornado",
        areas: [{ id: 0, revision: 0, center: { x: 1, y: 5 }, radius: 0.5 }],
      },
    },
    {
      step: 10,
      agents: [],
      disaster_state: {
        kind: "tornado",
        areas: [{ id: 0, revision: 10, center: { x: 9, y: 5 }, radius: 0.5 }],
      },
    },
  ];
  const sample = createFrameSampler(building, recorded, 0.1);
  expect(sample(0.5)!.disaster_state!.areas[0]!.center.x).toBe(1);
  expect(sample(1)!.disaster_state!.areas[0]!.center.x).toBe(9);
});
