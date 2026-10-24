import type { StressTestResult } from "../types/simulation";

// Synthetic analytics examples, unrelated to the edited building.
export const syntheticStressResult: StressTestResult = {
  baseline: {
    status: "completed",
    total_population: 34,
    evacuated: 34,
    remaining: 0,
    trapped: 0,
    clearance_steps: 100,
  },
  scenarios: [
    {
      scenario_id: "sample-slow",
      description: "Exit B blocked",
      rank: 3,
      severity: "moderate",
      modifications: {
        blocked_exit_ids: ["sample-exit-b"],
        added_obstructions: [],
      },
      metrics: {
        status: "completed",
        total_population: 34,
        evacuated: 34,
        remaining: 0,
        trapped: 0,
        clearance_steps: 180,
      },
    },
    {
      scenario_id: "sample-trapped",
      description: "Exit A blocked",
      rank: 1,
      severity: "critical",
      modifications: {
        blocked_exit_ids: ["sample-exit-a"],
        added_obstructions: [],
      },
      metrics: {
        status: "incomplete",
        total_population: 34,
        evacuated: 22,
        remaining: 12,
        trapped: 12,
        clearance_steps: null,
      },
    },
    {
      scenario_id: "sample-timeout",
      description: "Corridor obstruction",
      rank: 2,
      severity: "high",
      modifications: {
        blocked_exit_ids: [],
        added_obstructions: [
          { id: "sample-barrier", x: 8, y: 6, width: 2, height: 1 },
        ],
      },
      metrics: {
        status: "timeout",
        total_population: 34,
        evacuated: 30,
        remaining: 4,
        trapped: 0,
        clearance_steps: null,
      },
    },
  ],
};
