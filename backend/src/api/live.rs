use std::{
    convert::Infallible,
    pin::Pin,
    task::{Context, Poll},
    time::{Duration, Instant},
};

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, header},
    response::Response,
};
use futures_core::Stream;
use tokio::sync::mpsc;

use super::routes::ApiError;
use crate::{
    models::{BuildingScenario, SimulationStreamError, SimulationStreamEvent},
    simulation,
};

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

pub(super) async fn simulate_live(
    State(pool): State<super::execution::ExecutionPool>,
    headers: HeaderMap,
    payload: Result<Json<BuildingScenario>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(building) = payload?;
    building
        .validate()
        .map_err(simulation::SimulationError::InvalidScenario)?;
    // Bound pending output. A slow or disconnected reader cannot leave an
    // unbounded frame queue or a detached simulation computing indefinitely.
    let execution = pool.begin(super::routes::computation_id(&headers)?)?;
    let control = execution.control.clone();
    let cancel = super::execution::CancelOnDrop(control.clone());
    let permit = pool.acquire(&control).await?;
    let (sender, receiver) = mpsc::channel(2);
    tokio::task::spawn_blocking(move || {
        let _permits = (execution, permit);
        let mut started = None;
        let result = control.run(|| {
            simulation::simulate_live(&building, &mut |frame| {
                if sender.is_closed() || control.is_cancelled() {
                    return false;
                }
                let start = *started.get_or_insert_with(Instant::now);
                let deadline = start
                    + Duration::from_secs_f64(f64::from(frame.step) * building.time_step_seconds);
                // Small sleep intervals allow cancellation even for coarse ticks.
                while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
                    if sender.is_closed() || control.is_cancelled() {
                        return false;
                    }
                    std::thread::sleep(remaining.min(Duration::from_millis(25)));
                }
                send(
                    &sender,
                    &control,
                    SimulationStreamEvent::Frame {
                        frame: frame.clone(),
                    },
                )
            })
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
