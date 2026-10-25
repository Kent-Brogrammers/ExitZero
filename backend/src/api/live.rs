use std::{
    collections::{HashMap, hash_map::Entry},
    convert::Infallible,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{
        Path, Query, State,
        rejection::{JsonRejection, QueryRejection},
    },
    http::{HeaderMap, StatusCode, header},
    response::Response,
    routing::post,
};
use futures_core::Stream;
use tokio::sync::mpsc;

use super::routes::ApiError;
use crate::{
    models::{
        BuildingScenario, LiveRunQuery, LiveSpeedControl, SimulationStreamError,
        SimulationStreamEvent,
    },
    simulation,
};

#[derive(Clone, Default)]
struct LiveRuns(Arc<Mutex<HashMap<String, Arc<AtomicU32>>>>);

struct Registration {
    runs: LiveRuns,
    id: String,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.runs.0.lock().unwrap().remove(&self.id);
    }
}

pub(super) fn router(pool: super::execution::ExecutionPool) -> Router {
    let runs = LiveRuns::default();
    Router::new()
        .route("/api/simulate/live", post(simulate_live).with_state(pool))
        .route("/api/simulate/live/{id}/speed", post(set_speed))
        .with_state(runs.clone())
        .layer(axum::Extension(runs))
}

async fn set_speed(
    State(runs): State<LiveRuns>,
    Path(id): Path<String>,
    payload: Result<Json<LiveSpeedControl>, JsonRejection>,
) -> Result<Json<LiveSpeedControl>, ApiError> {
    let Json(control) = payload?;
    if ![1, 2, 4, 8].contains(&control.speed) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            "Live speed must be 1, 2, 4 or 8.",
        ));
    }
    let runs = runs.0.lock().unwrap();
    let speed = runs.get(&id).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "This live run has finished or was cancelled.",
        )
    })?;
    speed.store(control.speed, Ordering::Relaxed);
    Ok(Json(control))
}

struct LiveBody {
    receiver: mpsc::Receiver<Bytes>,
    _cancel: super::execution::CancelOnDrop,
}

impl Stream for LiveBody {
    type Item = Result<Bytes, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.receiver.poll_recv(cx).map(|item| item.map(Ok))
    }
}

fn send(
    sender: &mpsc::Sender<Bytes>,
    control: &simulation::ComputationControl,
    event: SimulationStreamEvent,
) -> bool {
    let mut json = serde_json::to_vec(&event).expect("simulation events contain finite numbers");
    json.push(b'\n');
    let mut bytes = Bytes::from(json);
    loop {
        if control.is_cancelled() {
            return false;
        }
        match sender.try_send(bytes) {
            Ok(()) => return true,
            Err(mpsc::error::TrySendError::Closed(_)) => return false,
            Err(mpsc::error::TrySendError::Full(pending)) => bytes = pending,
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

async fn simulate_live(
    State(pool): State<super::execution::ExecutionPool>,
    axum::Extension(runs): axum::Extension<LiveRuns>,
    headers: HeaderMap,
    query: Result<Query<LiveRunQuery>, QueryRejection>,
    payload: Result<Json<BuildingScenario>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(building) = payload?;
    building
        .validate()
        .map_err(simulation::SimulationError::InvalidScenario)?;
    let Query(query) = query.map_err(|error| {
        ApiError::new(StatusCode::BAD_REQUEST, "invalid_query", error.body_text())
    })?;
    let speed = Arc::new(AtomicU32::new(1));
    let registration = if let Some(id) = query.run_id {
        if id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_error",
                "Live run IDs must contain 1–64 letters, numbers, hyphens or underscores.",
            ));
        }
        match runs.0.lock().unwrap().entry(id.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(speed.clone());
            }
            Entry::Occupied(_) => {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "run_exists",
                    "This live run ID is already in use.",
                ));
            }
        }
        Some(Registration { runs, id })
    } else {
        None
    };
    // Bound pending output. A slow or disconnected reader cannot leave an
    // unbounded frame queue or a detached simulation computing indefinitely.
    let execution = pool.begin(super::routes::computation_id(&headers)?)?;
    let control = execution.control.clone();
    let cancel = super::execution::CancelOnDrop(control.clone());
    let permit = pool.acquire(&control).await?;
    let (sender, receiver) = mpsc::channel(2);
    tokio::task::spawn_blocking(move || {
        let _permits = (execution, permit);
        let _registration = registration;
        let mut last_clock = None;
        let mut paced_seconds = 0.0;
        let result = control.run(|| {
            simulation::simulate_live_with_chat(
                &building,
                &mut |frame| {
                    let target = f64::from(frame.step) * building.time_step_seconds;
                    // Integrate elapsed wall time at the current speed, so changing
                    // speed never jumps to a different point in the run.
                    loop {
                        if sender.is_closed() || control.is_cancelled() {
                            return false;
                        }
                        let now = Instant::now();
                        let rate = f64::from(speed.load(Ordering::Relaxed));
                        let previous = last_clock.replace(now).unwrap_or(now);
                        paced_seconds += now.duration_since(previous).as_secs_f64() * rate;
                        if paced_seconds >= target {
                            break;
                        }
                        std::thread::sleep(
                            Duration::from_secs_f64((target - paced_seconds) / rate)
                                .min(Duration::from_millis(25)),
                        );
                    }
                    send(
                        &sender,
                        &control,
                        SimulationStreamEvent::Frame {
                            frame: frame.clone(),
                        },
                    )
                },
                &mut |communication_events, agent_events| {
                    send(
                        &sender,
                        &control,
                        SimulationStreamEvent::Chat {
                            communication_events: communication_events.to_vec(),
                            agent_events: agent_events.to_vec(),
                        },
                    )
                },
            )
        });
        match result {
            Ok(result) => {
                send(
                    &sender,
                    &control,
                    SimulationStreamEvent::Complete { result },
                );
            }
            Err(simulation::SimulationError::Cancelled) => {}
            Err(error) => {
                send(
                    &sender,
                    &control,
                    SimulationStreamEvent::Error {
                        error: SimulationStreamError {
                            code: "validation_error".into(),
                            message: error.to_string(),
                        },
                    },
                );
            }
        }
    });
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(LiveBody {
            receiver,
            _cancel: cancel,
        }))
        .unwrap())
}
