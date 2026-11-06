import { expect, it, vi } from "vitest";
import { createAgentEffects } from "./agentEffects";
import { resolvedModifiers } from "../editor/agentModifiers";
import { syntheticBuilding as building } from "./playback.fixture";
import type {
  AgentModifierRecording,
  AnimationFrame,
} from "../types/simulation";

function fixture() {
  const colors: string[] = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn<(text: string, x: number, y: number) => void>(),
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    fill: vi.fn(() => colors.push(ctx.fillStyle)),
  };
  const canvas = {
    width: 600,
    height: 400,
    getContext: () => ctx,
    ownerDocument: { defaultView: { matchMedia: () => ({ matches: true }) } },
  } as unknown as HTMLCanvasElement;
  const definitions = [
    { id: "curious", name: "Curious", requires_emergency_discovery: true },
    { id: "scared", name: "Scared" },
  ];
  const metadata: AgentModifierRecording = {
    model_version: "static-modifiers-v1",
    definitions,
    agents: definitions.map((m, id) => ({
      id,
      source_id: `person-${id}`,
      source_ordinal: null,
      modifier_ids: [m.id],
      resolved: resolvedModifiers(definitions, [m.id]),
      speed_variation_multiplier: 1,
      uninjured_speed_metres_per_second: 1.3,
      reaction_steps: 0,
    })),
  };
  const frame: AnimationFrame = {
    step: 0,
    agents: [
      { id: 0, x: 1, y: 1 },
      { id: 1, x: 2, y: 1 },
    ],
  };
  return { ctx, canvas, colors, metadata, frame };
}

it("draws curious spawn markers and scared purple tint from recorded assignments", () => {
  const f = fixture();
  createAgentEffects([], f.metadata)(f.canvas, building, f.frame, 0, 1);
  expect(f.ctx.fillText.mock.calls.some(([text]) => text === "?")).toBe(true);
  expect(f.colors).toContain("#b875ed");
});

it("preserves injury colors instead of painting injured scared occupants purple", () => {
  const f = fixture();
  f.frame.agents[1]!.injury = 0.5;
  createAgentEffects([], f.metadata)(f.canvas, building, f.frame, 0, 1);
  expect(f.colors).not.toContain("#b875ed");
});

it("shows recorded priority/yield flashes only at the event time and rewinds them", () => {
  const f = fixture();
  const render = createAgentEffects(
    [{ step: 10, agent_id: 1, kind: "yielded_to_agent", subject_id: "0" }],
    f.metadata,
  );
  render(f.canvas, building, f.frame, 10 * building.time_step_seconds, 1);
  expect(f.ctx.fillText.mock.calls.some(([text]) => text === "Yield")).toBe(
    true,
  );
  expect(f.ctx.fillText.mock.calls.some(([text]) => text === "Priority")).toBe(
    true,
  );
  f.ctx.fillText.mockClear();
  render(f.canvas, building, f.frame, 0, 1);
  expect(
    f.ctx.fillText.mock.calls.some(
      ([text]) => text === "Yield" || text === "Priority",
    ),
  ).toBe(false);
});
