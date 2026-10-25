// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputationJobs } from "./ComputationJobs";
import { api } from "./api";
import type { JobSnapshot } from "../types/simulation";

vi.mock("./api", () => ({
  api: { listJobs: vi.fn(), cancelComputation: vi.fn() },
}));
const job = (id: string, status: JobSnapshot["status"]): JobSnapshot => ({
  id,
  server_id: "test",
  kind: "optimize",
  status,
  progress: {
    evaluations_completed: 3,
    evaluations_total: 11,
    step: 268,
    step_limit: 1500,
  },
  cached: false,
  error: null,
  context: `A long building or opening identifier ${"long-corridor-".repeat(10)} (${id})`,
});
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("groups actual job states, retains readable context and cache labels, and preserves cancellation and retrieval", async () => {
  const running = job("running", "running"),
    queued = job("queued", "queued"),
    completed = job("done", "completed"),
    failed = { ...job("failed", "failed"), error: "Invalid spawn placement" },
    cancelled = job("cancelled", "cancelled");
  const jobs = [running, queued, completed, failed, cancelled];
  vi.mocked(api.listJobs).mockImplementation(async () => ({
    server_id: "test",
    jobs,
  }));
  let confirm!: () => void;
  vi.mocked(api.cancelComputation).mockImplementation(
    () =>
      new Promise((resolve) => {
        confirm = () => {
          jobs[0] = { ...running, status: "cancelled" };
          resolve({ status: "cancelling" });
        };
      }),
  );
  const open = vi.fn();
  await act(async () =>
    root.render(
      <ComputationJobs
        current={{ ...completed, cached: true }}
        disabled={false}
        onOpen={open}
      />,
    ),
  );
  const active = host.querySelector('[aria-label="Active computations"]')!;
  const recent = host.querySelector('[aria-label="Recent computations"]')!;
  expect(active.querySelectorAll("li")).toHaveLength(2);
  expect(recent.querySelectorAll("li")).toHaveLength(3);
  expect(host.querySelector("h3")!.textContent).toBe("Computations");
  expect(active.textContent).toContain("Step 268 / 1500 limit");
  expect(host.textContent).toContain(running.context);
  expect(recent.textContent).toContain("Reused result");
  expect(recent.textContent).toContain("Invalid spawn placement");
  const cancelButton = active.querySelector<HTMLButtonElement>("button")!;
  await act(async () => cancelButton.click());
  expect(api.cancelComputation).toHaveBeenCalledExactlyOnceWith("running");
  expect(cancelButton.disabled).toBe(true);
  expect(cancelButton.textContent).toBe("Cancelling…");
  await act(async () => confirm());
  expect(
    host
      .querySelector('[aria-label="Active computations"]')!
      .querySelectorAll("li"),
  ).toHaveLength(1);
  await act(async () =>
    [...recent.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Open results")!
      .click(),
  );
  expect(open).toHaveBeenCalledExactlyOnceWith("done");
});

it("keeps a failed cancellation retryable and reports server restarts", async () => {
  sessionStorage.setItem("exitzero-job-server", "old-server");
  vi.mocked(api.listJobs).mockResolvedValue({
    server_id: "test",
    jobs: [job("run", "running")],
  });
  vi.mocked(api.cancelComputation).mockRejectedValue(
    new Error("Backend unavailable"),
  );
  await act(async () =>
    root.render(
      <ComputationJobs current={null} disabled={false} onOpen={vi.fn()} />,
    ),
  );
  expect(host.textContent).toContain("server restarted");
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".job-actions button")!.click(),
  );
  expect(host.querySelector('[role="alert"]')!.textContent).toContain(
    "Backend unavailable",
  );
  expect(
    host.querySelector<HTMLButtonElement>(".job-actions button")!.disabled,
  ).toBe(false);
});
