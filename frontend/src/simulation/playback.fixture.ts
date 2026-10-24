import type { BuildingScenario, SimulationResult } from "../types/simulation";

/** Scripted development data only. No simulation engine produced these frames. */
export const syntheticBuilding: BuildingScenario = {
  width: 4,
  height: 3,
  walls: [
    {
      id: "north",
      start: { x: 0.25, y: 0.25 },
      end: { x: 3.75, y: 0.25 },
      thickness: 0.1,
    },
    {
      id: "east-wall",
      start: { x: 3.75, y: 0.25 },
      end: { x: 3.75, y: 2.75 },
      thickness: 0.1,
    },
    {
      id: "south",
      start: { x: 3.75, y: 2.75 },
      end: { x: 0.25, y: 2.75 },
      thickness: 0.1,
    },
    {
      id: "west-wall",
      start: { x: 0.25, y: 2.75 },
      end: { x: 0.25, y: 0.25 },
      thickness: 0.1,
    },
    {
      id: "partition",
      start: { x: 2, y: 0.25 },
      end: { x: 2, y: 2.75 },
      thickness: 0.1,
    },
  ],
  doors: [{ id: "door", wall_id: "partition", offset: 1, width: 0.8 }],
  exits: [
    { id: "west", wall_id: "west-wall", offset: 0.85, width: 0.8 },
    { id: "east", wall_id: "east-wall", offset: 0.85, width: 0.8 },
  ],
  spawn_zones: [
    { id: "spawn-west", x: 0.7, y: 1.2, width: 0.7, height: 0.6, count: 1 },
    { id: "spawn-east", x: 2.6, y: 1.2, width: 0.7, height: 0.6, count: 1 },
  ],
  blocked_exit_ids: [],
  obstructions: [],
  agent_radius: 0.12,
  time_step_seconds: 0.1,
  seed: 42,
  max_steps: 100,
};

export const syntheticResult: SimulationResult = {
  status: "completed",
  total_population: 2,
  evacuated: 2,
  remaining: 0,
  trapped: 0,
  clearance_steps: 80,
  width: 4,
  height: 3,
  time_step_seconds: 0.1,
  traffic_samples: [],
  frames: [
    {
      step: 0,
      agents: [
        { id: 0, x: 1.25, y: 1.5 },
        { id: 1, x: 2.75, y: 1.5 },
      ],
    },
    {
      step: 10,
      agents: [
        { id: 0, x: 0.9, y: 1.5 },
        { id: 1, x: 3.1, y: 1.5 },
      ],
    },
    {
      step: 25,
      agents: [
        { id: 0, x: 0.45, y: 1.5 },
        { id: 1, x: 3.55, y: 1.5 },
      ],
    },
    {
      step: 45,
      agents: [
        { id: 0, x: 0.1, y: 1.5 },
        { id: 1, x: 3.9, y: 1.5 },
      ],
    },
    { step: 80, agents: [] },
  ],
};
