import type { JobSnapshot } from "../types/simulation";

export function jobName(job: Pick<JobSnapshot, "kind">) {
  return job.kind === "replay"
    ? "Scenario recording"
    : job.kind === "simulate"
      ? "Calculation"
      : job.kind === "stress"
        ? "Stress test"
        : "Optimization";
}

export function jobProgress(job: JobSnapshot) {
  if (job.status !== "running" && job.status !== "cancelling") return "";
  const p = job.progress;
  return [
    p.evaluations_total
      ? `${p.evaluations_completed} / ${p.evaluations_total} evaluations finished`
      : "",
    p.step_limit ? `Step ${p.step} / ${p.step_limit} limit` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function jobLabel(job: JobSnapshot) {
  const operation = jobName(job);
  const progress = job.progress;
  return `${operation} · ${job.status}${job.cached ? " · reused completed result" : ""}${job.status === "running" ? `${progress.evaluations_total ? ` · ${progress.evaluations_completed}/${progress.evaluations_total} evaluations finished` : ""}${progress.step_limit ? ` · step ${progress.step}/${progress.step_limit} limit` : ""}` : ""} · ${job.context ?? job.id.slice(-8)}`;
}
