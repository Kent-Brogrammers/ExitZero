use std::{
    convert::Infallible,
    pin::Pin,
    task::{Context, Poll},
    time::{Duration, Instant},
};

use axum::{
    Json,
    body::{Body, Bytes},
    extract::rejection::JsonRejection,
    http::header,
    response::Response,
};
use futures_core::Stream;
use tokio::sync::mpsc;

use super::routes::ApiError;
use crate::{
    models::{BuildingScenario, SimulationStreamError, SimulationStreamEvent},
    simulation,
};

struct LiveBody(mpsc::Receiver<Bytes>);

impl Stream for LiveBody {
    type Item = Result<Bytes, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.0.poll_recv(cx).map(|item| item.map(Ok))
    }
}

fn send(sender: &mpsc::Sender<Bytes>, event: SimulationStreamEvent) -> bool {
    let mut json = serde_json::to_vec(&event).expect("simulation events contain finite numbers");
    json.push(b'\n');
    sender.blocking_send(Bytes::from(json)).is_ok()
}

pub(super) async fn simulate_live(
    payload: Result<Json<BuildingScenario>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(building) = payload?;
    building
        .validate()
        .map_err(simulation::SimulationError::InvalidScenario)?;
    // Bound pending output. A slow or disconnected reader cannot leave an
    // unbounded frame queue or a detached simulation computing indefinitely.
    let (sender, receiver) = mpsc::channel(2);
    tokio::task::spawn_blocking(move || {
        let mut started = None;
        let result = simulation::simulate_live(&building, &mut |frame| {
            if sender.is_closed() {
                return false;
            }
            let start = *started.get_or_insert_with(Instant::now);
            let deadline =
                start + Duration::from_secs_f64(f64::from(frame.step) * building.time_step_seconds);
            // Small sleep intervals allow cancellation even for coarse ticks.
            while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
                if sender.is_closed() {
                    return false;
                }
                std::thread::sleep(remaining.min(Duration::from_millis(25)));
            }
            send(
                &sender,
                SimulationStreamEvent::Frame {
                    frame: frame.clone(),
                },
            )
        });
        match result {
            Ok(result) => {
                send(&sender, SimulationStreamEvent::Complete { result });
            }
            Err(simulation::SimulationError::Cancelled) => {}
            Err(error) => {
                send(
                    &sender,
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
        .body(Body::from_stream(LiveBody(receiver)))
        .unwrap())
}
