import { useEffect, useState } from "react";
import { api } from "./api";
import type { JobList, JobSnapshot } from "../types/simulation";

import { jobName, jobProgress } from "./jobPresentation";
import "./ComputationJobs.css";

export function ComputationJobs({
  current,
  disabled,
  onOpen,
}: {
  current: JobSnapshot | null;
  disabled: boolean;
  onOpen: (id: string) => void;
}) {
  const [list, setList] = useState<JobList | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [cancelling, setCancelling] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      try {
        const next = await api.listJobs(controller.signal);
        if (controller.signal.aborted) return;
        try {
          const previous = sessionStorage.getItem("exitzero-job-server");
          if (previous && previous !== next.server_id)
            setNotice(
              "The server restarted. Previous in-memory jobs and results are no longer available.",
            );
          sessionStorage.setItem("exitzero-job-server", next.server_id);
        } catch {
          /* Storage can be disabled; server retrieval still works. */
        }
        setList(next);
        setError("");
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Cannot retrieve jobs.",
          );
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [current?.id, current?.status, refreshKey]);
  const displayedCurrent =
    current && (!list || current.server_id === list.server_id) ? current : null;
  const jobs = (list?.jobs ?? (displayedCurrent ? [displayedCurrent] : [])).map(
    (job) => ({
      ...job,
      cached:
        job.cached ||
        (displayedCurrent?.id === job.id && displayedCurrent.cached),
    }),
  );
  const isActive = (job: JobSnapshot) =>
    ["queued", "running", "cancelling"].includes(job.status);
  const active = jobs.filter(isActive);
  const recent = jobs.filter((job) => !isActive(job));
  useEffect(() => {
    if (!list) return;
    setCancelling((previous) => {
      const remaining = new Set(
        [...previous].filter((id) =>
          list.jobs.some(
            (job) =>
              job.id === id &&
              ["queued", "running", "cancelling"].includes(job.status),
          ),
        ),
      );
      return remaining.size === previous.size ? previous : remaining;
    });
  }, [list]);
  async function cancel(id: string) {
    setError("");
    setCancelling((previous) => new Set(previous).add(id));
    try {
      await api.cancelComputation(id);
      setRefreshKey((value) => value + 1);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not cancel computation. Retry Cancel.",
      );
      setCancelling((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  }
  function rows(entries: JobSnapshot[]) {
    return (
      <ul className="job-list">
        {entries.map((job) => {
          const stopping = cancelling.has(job.id) && isActive(job);
          const status = stopping ? "cancelling" : job.status;
          const progress = jobProgress({ ...job, status });
          return (
            <li className="job-card" key={job.id}>
              <div className="job-info">
                <div className="job-heading">
                  <h5>{jobName(job)}</h5>
                  <span className="job-status" data-status={status}>
                    {status}
                  </span>
                  {job.cached && (
                    <span className="job-cached">Reused result</span>
                  )}
                </div>
                <p className="job-context">
                  {job.context ?? `Run ${job.id.slice(-8)}`}
                </p>
                {progress && <p className="job-progress">{progress}</p>}
                {job.error && <p className="job-error">{job.error}</p>}
              </div>
              {(isActive(job) || job.status === "completed") && (
                <div className="job-actions">
                  {job.status === "completed" ? (
                    <button
                      type="button"
                      className="studio-control"
                      disabled={disabled}
                      onClick={() => onOpen(job.id)}
                    >
                      Open results
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="studio-control"
                      disabled={stopping || job.status === "cancelling"}
                      onClick={() => void cancel(job.id)}
                    >
                      {stopping || job.status === "cancelling"
                        ? "Cancelling…"
                        : "Cancel"}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <section className="computation-jobs" aria-label="Computations">
      <header className="jobs-header">
        <div>
          <h3>Computations</h3>
          <p>
            Background jobs survive refresh. Live playback stops on disconnect.
          </p>
        </div>
        <span className="jobs-count">{active.length} active</span>
      </header>
      <div className="jobs-scroll">
        {notice && (
          <p className="jobs-notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="jobs-error" role="alert">
            {error}
          </p>
        )}
        {!list && !jobs.length && !error && (
          <p className="jobs-empty" role="status">
            Loading computations…
          </p>
        )}
        <section className="jobs-group" aria-label="Active computations">
          <h4>
            Active <span>{active.length}</span>
          </h4>
          {active.length ? (
            rows(active)
          ) : (
            <p className="jobs-empty">No active computations.</p>
          )}
        </section>
        <section className="jobs-group" aria-label="Recent computations">
          <h4>
            Recent <span>{recent.length}</span>
          </h4>
          {recent.length ? (
            rows(recent)
          ) : (
            <p className="jobs-empty">No recent computations.</p>
          )}
        </section>
      </div>
      <footer className="jobs-footer">
        Results are kept for up to 15 minutes, within local memory limits.
        Server restarts clear history. Completed means calculation finished, not
        necessarily full evacuation.
      </footer>
    </section>
  );
}
