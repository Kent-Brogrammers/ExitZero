//! Local, bounded experiment storage. Jobs outlive an HTTP connection, not a
//! server restart. Legacy synchronous and live routes share the same workers.
use super::{execution::ExecutionPool, routes::ApiError};
use crate::{
    models::*,
    simulation::{self, ComputationControl, SimulationError},
};
use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_JOBS: usize = 24;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum JobRequest {
    Simulate {
        building: BuildingScenario,
    },
    Stress {
        request: StressTestRequest,
    },
    Optimize {
        request: OptimizeRequest,
    },
    Replay {
        stress_job_id: String,
        scenario_id: String,
    },
}
impl JobRequest {
    fn context(&self) -> String {
        let building = match self {
            Self::Simulate { building } => building,
            Self::Stress { request } => &request.building,
            Self::Optimize { request } => &request.building,
            Self::Replay { scenario_id, .. } => return scenario_id.clone(),
        };
        let emergency = if building.pursuit.is_some() {
            "pursuit"
        } else {
            match building.disaster.map(|d| d.kind) {
                Some(DisasterKind::Fire) => "fire",
                Some(DisasterKind::GasLeak) => "gas",
                Some(DisasterKind::Tornado) => "tornado",
                None => "baseline",
            }
        };
        format!(
            "{} × {} m · {} occupants · {emergency} · seed {}",
            building.width,
            building.height,
            building.population(),
            building.seed
        )
    }
    fn kind(&self) -> &'static str {
        match self {
            Self::Simulate { .. } => "simulate",
            Self::Stress { .. } => "stress",
            Self::Optimize { .. } => "optimize",
            Self::Replay { .. } => "replay",
        }
    }
    fn validate(&self) -> Result<(), SimulationError> {
        match self {
            Self::Simulate { building } => building.validate(),
            Self::Stress { request } => request.validate(),
            Self::Optimize { request } => request.validate(),
            Self::Replay {
                stress_job_id,
                scenario_id,
            } => {
                if stress_job_id.is_empty()
                    || stress_job_id.len() > 80
                    || scenario_id.is_empty()
                    || scenario_id.len() > 128
                {
                    Err("Invalid source job or scenario ID.".into())
                } else {
                    Ok(())
                }
            }
        }
        .map_err(SimulationError::InvalidScenario)
    }
    fn compute(&self, replay: Option<&ReplaySource>) -> Result<Output, SimulationError> {
        let completed = |m: &SimulationMetrics| m.status == SimulationStatus::Completed;
        let (json, reusable) = match self {
            Self::Simulate { building } => {
                let result = simulation::simulate(building)?;
                (
                    serde_json::to_string(&result).unwrap(),
                    completed(&result.metrics),
                )
            }
            Self::Stress { request } => {
                let result = crate::stress_testing::stress_test(request)?;
                let reusable = completed(&result.baseline)
                    && result.scenarios.iter().all(|s| completed(&s.metrics));
                (serde_json::to_string(&result).unwrap(), reusable)
            }
            Self::Optimize { request } => {
                let result = crate::optimization::optimize(request)?;
                let reusable = completed(&result.baseline)
                    && result.candidates.iter().all(|s| completed(&s.metrics));
                (serde_json::to_string(&result).unwrap(), reusable)
            }
            Self::Replay {
                stress_job_id,
                scenario_id,
            } => {
                let source = replay.expect("replay source is resolved before admission");
                let (building, result) = crate::stress_testing::record_scenario(
                    &source.request,
                    scenario_id,
                    &source.metrics,
                )?;
                let reusable = completed(&result.metrics);
                (serde_json::json!({"stress_job_id":stress_job_id,"scenario_id":scenario_id,"building":building,"result":result}).to_string(),reusable)
            }
        };
        Ok(Output { json, reusable })
    }
}
struct Output {
    json: String,
    reusable: bool,
}
struct ReplaySource {
    request: StressTestRequest,
    metrics: SimulationMetrics,
}
#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Queued,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
}
struct Job {
    request: JobRequest,
    key: String,
    control: Arc<ComputationControl>,
    status: Status,
    output: Option<Output>,
    error: Option<String>,
    finished: Option<Instant>,
}
#[derive(Serialize)]
struct Snapshot {
    id: String,
    server_id: String,
    kind: &'static str,
    status: Status,
    progress: simulation::ComputationProgress,
    cached: bool,
    error: Option<String>,
    context: String,
}
struct Store {
    pool: ExecutionPool,
    server_id: String,
    jobs: Mutex<BTreeMap<String, Job>>,
}
impl Store {
    fn snapshot(&self, id: &str, job: &Job, cached: bool) -> Snapshot {
        Snapshot {
            id: id.into(),
            server_id: self.server_id.clone(),
            kind: job.request.kind(),
            status: if job.finished.is_none() && job.control.is_cancelled() {
                Status::Cancelling
            } else {
                job.status
            },
            progress: job.control.progress(),
            cached,
            error: job.error.clone(),
            context: job.request.context(),
        }
    }
    fn cleanup(jobs: &mut BTreeMap<String, Job>) {
        jobs.retain(|_, job| job.finished.is_none_or(|at| at.elapsed() < TTL));
    }
    fn evict(jobs: &mut BTreeMap<String, Job>) -> bool {
        let oldest = jobs
            .iter()
            .filter_map(|(id, j)| j.finished.map(|at| (id.clone(), at)))
            .min_by_key(|(_, at)| *at);
        if let Some((id, _)) = oldest {
            jobs.remove(&id);
            true
        } else {
            false
        }
    }
    fn bytes(jobs: &BTreeMap<String, Job>) -> usize {
        jobs.values()
            .filter_map(|j| j.output.as_ref())
            .map(|o| o.json.len())
            .sum()
    }
    async fn submit(
        self: &Arc<Self>,
        id: String,
        request: JobRequest,
    ) -> Result<Snapshot, ApiError> {
        request.validate()?;
        // The binary and all its results share a server instance. A restart
        // invalidates everything; no older algorithm's output crosses it.
        let key = format!(
            "{}:{}",
            self.server_id,
            serde_json::to_string(&request).unwrap()
        );
        let mut jobs = self.jobs.lock().unwrap();
        Self::cleanup(&mut jobs);
        let replay = if let JobRequest::Replay {
            stress_job_id,
            scenario_id,
        } = &request
        {
            let parent = jobs.get(stress_job_id).ok_or_else(missing)?;
            let JobRequest::Stress { request } = &parent.request else {
                return Err(ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "invalid_replay_source",
                    "Replay requires a completed stress-test job.",
                ));
            };
            let output = parent.output.as_ref().ok_or_else(|| {
                ApiError::new(
                    StatusCode::CONFLICT,
                    "job_not_completed",
                    "Wait for the source stress test to complete.",
                )
            })?;
            let result: StressTestResult = serde_json::from_str(&output.json)
                .expect("stored stress output matches its own contract");
            let scenario = result
                .scenarios
                .into_iter()
                .find(|s| s.scenario_id == *scenario_id)
                .ok_or_else(|| {
                    ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "unknown_scenario",
                        "This scenario is not in the source stress test.",
                    )
                })?;
            Some(ReplaySource {
                request: request.clone(),
                metrics: scenario.metrics,
            })
        } else {
            None
        };
        if let Some((id, job)) = jobs.iter().find(|(_, j)| {
            j.key == key
                && j.status == Status::Completed
                && j.output.as_ref().is_some_and(|o| o.reusable)
        }) {
            return Ok(self.snapshot(id, job, true));
        }
        if jobs.contains_key(&id) {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "duplicate_job_id",
                "This job ID already exists.",
            ));
        }
        while jobs.len() >= MAX_JOBS {
            if !Self::evict(&mut jobs) {
                return Err(ApiError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "job_limit",
                    "Too many active jobs.",
                ));
            }
        }
        let execution = self.pool.begin(Some(id.clone()))?;
        let control = execution.control.clone();
        let job = Job {
            request: request.clone(),
            key,
            control: control.clone(),
            status: Status::Queued,
            output: None,
            error: None,
            finished: None,
        };
        let snapshot = self.snapshot(&id, &job, false);
        jobs.insert(id.clone(), job);
        drop(jobs);
        let store = self.clone();
        tokio::spawn(async move {
            let _cancel = super::execution::CancelOnDrop(control.clone());
            let _lifecycle = execution;
            let result = match store.pool.acquire(&control).await {
                Err(_) => Err(SimulationError::Cancelled),
                Ok(permit) => {
                    store.jobs.lock().unwrap().get_mut(&id).unwrap().status = Status::Running;
                    let worker_control = control.clone();
                    tokio::task::spawn_blocking(move || {
                        let _resources = permit;
                        worker_control.run(|| request.compute(replay.as_ref()))
                    })
                    .await
                    .unwrap_or_else(|_| {
                        Err(SimulationError::InvalidScenario(
                            "Computation worker failed.".into(),
                        ))
                    })
                }
            };
            let mut jobs = store.jobs.lock().unwrap();
            // Running entries are never evicted. Only successful complete
            // computations can own a result; cancellation discards all output.
            let output = match result {
                Ok(output) if !control.is_cancelled() && output.json.len() <= MAX_BYTES => {
                    Some(output)
                }
                Ok(_) if !control.is_cancelled() => {
                    let job = jobs.get_mut(&id).unwrap();
                    job.status = Status::Failed;
                    job.error = Some("Recording exceeds the 64 MiB local result limit. Reduce the population or step limit.".into());
                    None
                }
                Err(error)
                    if !control.is_cancelled() && !matches!(error, SimulationError::Cancelled) =>
                {
                    let job = jobs.get_mut(&id).unwrap();
                    job.status = Status::Failed;
                    job.error = Some(error.to_string());
                    None
                }
                _ => None,
            };
            if let Some(output) = output {
                while Self::bytes(&jobs) + output.json.len() > MAX_BYTES {
                    if !Self::evict(&mut jobs) {
                        break;
                    }
                }
                let job = jobs.get_mut(&id).unwrap();
                job.status = Status::Completed;
                job.output = Some(output);
            }
            let job = jobs.get_mut(&id).unwrap();
            if job.status != Status::Completed && job.status != Status::Failed {
                job.status = Status::Cancelled;
            }
            job.finished = Some(Instant::now());
        });
        Ok(snapshot)
    }
}

pub(super) fn router(pool: ExecutionPool) -> Router {
    let store = Arc::new(Store {
        pool,
        server_id: format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ),
        jobs: Mutex::default(),
    });
    let weak = Arc::downgrade(&store);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let Some(store) = weak.upgrade() else {
                break;
            };
            Store::cleanup(&mut store.jobs.lock().unwrap());
        }
    });
    Router::new()
        .route("/api/jobs", get(list).post(submit))
        .route("/api/jobs/{id}", get(status))
        .route("/api/jobs/{id}/result", get(result))
        .route("/api/jobs/{id}/request", get(request))
        .with_state(store)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Submission {
    id: String,
    request: JobRequest,
}
async fn submit(
    State(store): State<Arc<Store>>,
    payload: Result<Json<Submission>, JsonRejection>,
) -> Result<Json<Snapshot>, ApiError> {
    let Json(body) = payload?;
    Ok(Json(store.submit(body.id, body.request).await?))
}
async fn list(State(store): State<Arc<Store>>) -> Json<serde_json::Value> {
    let mut jobs = store.jobs.lock().unwrap();
    Store::cleanup(&mut jobs);
    Json(
        serde_json::json!({"server_id": store.server_id, "jobs": jobs.iter().map(|(id,j)| store.snapshot(id,j,false)).collect::<Vec<_>>()}),
    )
}
fn missing() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "job_expired",
        "This job expired or the server restarted. Submit the experiment again.",
    )
}
async fn status(
    State(store): State<Arc<Store>>,
    Path(id): Path<String>,
) -> Result<Json<Snapshot>, ApiError> {
    let mut jobs = store.jobs.lock().unwrap();
    Store::cleanup(&mut jobs);
    Ok(Json(store.snapshot(
        &id,
        jobs.get(&id).ok_or_else(missing)?,
        false,
    )))
}
async fn request(
    State(store): State<Arc<Store>>,
    Path(id): Path<String>,
) -> Result<Json<JobRequest>, ApiError> {
    let mut jobs = store.jobs.lock().unwrap();
    Store::cleanup(&mut jobs);
    Ok(Json(jobs.get(&id).ok_or_else(missing)?.request.clone()))
}
async fn result(
    State(store): State<Arc<Store>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let mut jobs = store.jobs.lock().unwrap();
    Store::cleanup(&mut jobs);
    let job = jobs.get(&id).ok_or_else(missing)?;
    let output = job.output.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            "job_not_completed",
            "This job has no completed result.",
        )
    })?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        output.json.clone(),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store(pool: ExecutionPool) -> Arc<Store> {
        Arc::new(Store {
            pool,
            server_id: "test-version".into(),
            jobs: Mutex::default(),
        })
    }
    fn building() -> BuildingScenario {
        let mut b: BuildingScenario =
            serde_json::from_str(include_str!("../../../shared/examples/building.json")).unwrap();
        for zone in &mut b.spawn_zones {
            zone.count = 1;
        }
        b
    }
    async fn finished(store: &Store, id: &str) -> Status {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                {
                    let jobs = store.jobs.lock().unwrap();
                    let job = &jobs[id];
                    if job.finished.is_some() {
                        return job.status;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn exact_completed_results_are_retrievable_and_reused_but_changed_requests_are_not() {
        let store = store(ExecutionPool::new(1, 8));
        let request = JobRequest::Simulate {
            building: building(),
        };
        store.submit("first".into(), request.clone()).await.unwrap();
        assert!(matches!(finished(&store, "first").await, Status::Completed));
        let cached = store
            .submit("second".into(), request.clone())
            .await
            .unwrap();
        assert!(cached.cached);
        assert_eq!(cached.id, "first");
        {
            let jobs = store.jobs.lock().unwrap();
            let JobRequest::Simulate { building } = &request else {
                unreachable!()
            };
            assert!(
                jobs["first"].output.as_ref().unwrap().json
                    == serde_json::to_string(&simulation::simulate(building).unwrap()).unwrap()
            );
        }
        let mut changed = building();
        changed.seed += 1;
        assert!(
            !store
                .submit("changed".into(), JobRequest::Simulate { building: changed })
                .await
                .unwrap()
                .cached
        );
        assert!(matches!(
            finished(&store, "changed").await,
            Status::Completed
        ));
    }
    #[tokio::test]
    async fn incomplete_evacuation_is_available_but_never_automatically_reused() {
        let store = store(ExecutionPool::new(1, 8));
        let mut b = building();
        b.max_steps = 1;
        let request = JobRequest::Simulate { building: b };
        store
            .submit("limited".into(), request.clone())
            .await
            .unwrap();
        assert!(matches!(
            finished(&store, "limited").await,
            Status::Completed
        ));
        assert!(
            !store.jobs.lock().unwrap()["limited"]
                .output
                .as_ref()
                .unwrap()
                .reusable
        );
        assert!(!store.submit("retry".into(), request).await.unwrap().cached);
        finished(&store, "retry").await;
    }
    #[tokio::test]
    async fn scenario_recording_matches_tested_metrics_and_preserves_source_geometry_and_hazards() {
        let store = store(ExecutionPool::new(1, 8));
        let mut b = building();
        b.disaster = Some(Disaster {
            kind: DisasterKind::Fire,
            center: Point { x: 15.0, y: 2.0 },
            radius: 0.5,
            dynamics: None,
        });
        let exit = b.exits[0].id.clone();
        b.opening_events = serde_json::from_value(
            serde_json::json!([{"step":10,"opening_id":exit,"blocked":false}]),
        )
        .unwrap();
        let original = serde_json::to_string(&b).unwrap();
        let source = StressTestRequest {
            building: b,
            config: StressTestConfig {
                max_scenarios: 1,
                block_each_exit: true,
                obstruction_candidates: vec![],
            },
        };
        store
            .submit("stress".into(), JobRequest::Stress { request: source })
            .await
            .unwrap();
        assert!(matches!(
            finished(&store, "stress").await,
            Status::Completed
        ));
        let scenario_id = format!("block-exit:{exit}");
        store
            .submit(
                "replay".into(),
                JobRequest::Replay {
                    stress_job_id: "stress".into(),
                    scenario_id: scenario_id.clone(),
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            finished(&store, "replay").await,
            Status::Completed
        ));
        let jobs = store.jobs.lock().unwrap();
        let recorded: serde_json::Value =
            serde_json::from_str(&jobs["replay"].output.as_ref().unwrap().json).unwrap();
        let tested: StressTestResult =
            serde_json::from_str(&jobs["stress"].output.as_ref().unwrap().json).unwrap();
        let replay: SimulationResult = serde_json::from_value(recorded["result"].clone()).unwrap();
        assert_eq!(
            serde_json::to_string(&replay.metrics).unwrap(),
            serde_json::to_string(&tested.scenarios[0].metrics).unwrap()
        );
        assert_eq!(recorded["scenario_id"], scenario_id);
        assert_eq!(recorded["building"]["blocked_exit_ids"][0], exit);
        let replay_building: BuildingScenario =
            serde_json::from_value(recorded["building"].clone()).unwrap();
        assert!(replay_building.opening_events.is_empty());
        assert!(
            replay.frames.iter().all(|frame| frame
                .blocked_opening_ids
                .as_ref()
                .unwrap()
                .contains(&exit))
        );
        assert!(replay.frames[0].disaster_state.is_some());
        let JobRequest::Stress { request } = &jobs["stress"].request else {
            unreachable!()
        };
        assert_eq!(serde_json::to_string(&request.building).unwrap(), original);
    }
    #[tokio::test]
    async fn queued_jobs_can_be_cancelled_without_occupying_a_worker_or_returning_output() {
        let pool = ExecutionPool::new(1, 1);
        let active = pool.begin(Some("live".into())).unwrap();
        let worker = pool.acquire(&active.control).await.unwrap();
        let store = store(pool.clone());
        store
            .submit(
                "queued".into(),
                JobRequest::Simulate {
                    building: building(),
                },
            )
            .await
            .unwrap();
        assert!(
            store
                .submit(
                    "overflow".into(),
                    JobRequest::Simulate {
                        building: building()
                    }
                )
                .await
                .is_err()
        );
        pool.cancel("queued").unwrap();
        pool.cancel("queued").unwrap();
        assert!(matches!(
            finished(&store, "queued").await,
            Status::Cancelled
        ));
        assert!(store.jobs.lock().unwrap()["queued"].output.is_none());
        assert!(!active.control.is_cancelled());
        drop((worker, active));
        // Expiry removes cancelled work as well as completed results.
        let mut jobs = store.jobs.lock().unwrap();
        jobs.get_mut("queued").unwrap().finished = Some(Instant::now() - TTL);
        Store::cleanup(&mut jobs);
        assert!(jobs.is_empty());
    }
}
