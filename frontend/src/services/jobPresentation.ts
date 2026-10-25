import type { JobSnapshot } from "../types/simulation";

export function jobLabel(job: JobSnapshot) {
  const operation =
    job.kind === "replay"
      ? "Scenario recording"
      : job.kind === "simulate"
        ? "Calculation"
        : job.kind === "stress"
          ? "Stress test"
          : "Optimization";
  const progress = job.progress;
  return `${operation} · ${job.status}${job.cached ? " · reused completed result" : ""}${job.status === "running" ? `${progress.evaluations_total ? ` · ${progress.evaluations_completed}/${progress.evaluations_total} evaluations finished` : ""}${progress.step_limit ? ` · step ${progress.step}/${progress.step_limit} limit` : ""}` : ""} · ${job.context ?? job.id.slice(-8)}`;
}
