import { useEffect, useState } from "react";
import { api } from "./api";
import type { JobList, JobSnapshot } from "../types/simulation";

import { jobLabel } from "./jobPresentation";

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
  }, [current?.id, current?.status]);
  const jobs = list?.jobs ?? [];
  const displayedCurrent =
    current && (!list || current.server_id === list.server_id) ? current : null;
  const active = jobs.filter((j) =>
    ["queued", "running", "cancelling"].includes(j.status),
  ).length;
  return (
    <section className="computation-jobs" aria-label="Computations">
      <h3>
        Computations{active ? ` · ${active} active` : ""}
        {displayedCurrent ? ` — ${jobLabel(displayedCurrent)}` : ""}
      </h3>
      <p className="note">
        Calculate Results, stress tests, and optimization continue after
        refresh. Reopen or cancel them here. Live playback stops when its
        connection closes. Results expire after 15 minutes and may be evicted
        earlier to stay within local memory limits. Completed means the
        computation finished; the evacuation itself may still be incomplete.
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="status">{error}</p>}
      {!jobs.length && (
        <p className="note">No saved computations on this server.</p>
      )}
      <ul>
        {jobs.map((job) => (
          <li key={job.id}>
            <span>{jobLabel(job)}</span>{" "}
            {job.status === "completed" && (
              <button
                className="studio-control"
                disabled={disabled}
                onClick={() => onOpen(job.id)}
              >
                Open results
              </button>
            )}
            {(job.status === "queued" || job.status === "running") && (
              <button
                className="studio-control"
                onClick={() =>
                  void api
                    .cancelComputation(job.id)
                    .catch((failure) => setError(String(failure)))
                }
              >
                Cancel
              </button>
            )}
            {job.error && <p>{job.error}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
