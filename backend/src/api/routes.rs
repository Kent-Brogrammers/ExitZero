use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use tower_http::cors::CorsLayer;

use crate::{
    models::{
        BuildingScenario, OptimizationResult, OptimizeRequest, SimulationResult, StressTestRequest,
        StressTestResult,
    },
    optimization,
    simulation::{self, SimulationError},
    stress_testing,
};

pub fn router() -> Router {
    let workers = std::env::var("EXITZERO_COMPUTE_WORKERS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1)
        .clamp(1, 4);
    router_with_pool(super::execution::ExecutionPool::new(workers, 8))
}

fn router_with_pool(pool: super::execution::ExecutionPool) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/simulate", post(simulate))
        .route("/api/stress-test", post(stress_test))
        .route("/api/optimize", post(optimize))
        .route("/api/computations/{id}/cancel", post(cancel))
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "not_found", "route not found") })
        .method_not_allowed_fallback(|| async {
            ApiError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                "method not allowed",
            )
        })
        .with_state(pool.clone())
        .merge(super::live::router(pool.clone()))
        .merge(super::jobs::router(pool))
        .layer(
            CorsLayer::new()
                .allow_origin([
                    HeaderValue::from_static("http://localhost:5173"),
                    HeaderValue::from_static("http://127.0.0.1:5173"),
                ])
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([
                    axum::http::header::CONTENT_TYPE,
                    axum::http::HeaderName::from_static("x-computation-id"),
                ]),
        )
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "exitzero",
    })
}

#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: ErrorDetail<'a>,
}

#[derive(Serialize)]
struct ErrorDetail<'a> {
    code: &'a str,
    message: &'a str,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: ErrorDetail {
                    code: self.code,
                    message: &self.message,
                },
            }),
        )
            .into_response()
    }
}

impl From<JsonRejection> for ApiError {
    fn from(error: JsonRejection) -> Self {
        Self::new(error.status(), "invalid_json", error.body_text())
    }
}

impl From<SimulationError> for ApiError {
    fn from(error: SimulationError) -> Self {
        match error {
            SimulationError::InvalidScenario(message) => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_error",
                message,
            ),
            SimulationError::NotImplemented => Self::new(
                StatusCode::NOT_IMPLEMENTED,
                "not_implemented",
                "This computation is not implemented yet; no results were generated.",
            ),
            SimulationError::Cancelled => Self::new(
                StatusCode::REQUEST_TIMEOUT,
                "cancelled",
                "Simulation cancelled.",
            ),
        }
    }
}

async fn simulate(
    State(pool): State<super::execution::ExecutionPool>,
    headers: HeaderMap,
    payload: Result<Json<BuildingScenario>, JsonRejection>,
) -> Result<Json<SimulationResult>, ApiError> {
    let Json(building) = payload?;
    Ok(Json(
        pool.run(computation_id(&headers)?, move || {
            simulation::simulate(&building)
        })
        .await?,
    ))
}

async fn stress_test(
    State(pool): State<super::execution::ExecutionPool>,
    headers: HeaderMap,
    payload: Result<Json<StressTestRequest>, JsonRejection>,
) -> Result<Json<StressTestResult>, ApiError> {
    let Json(request) = payload?;
    Ok(Json(
        pool.run(computation_id(&headers)?, move || {
            stress_testing::stress_test(&request)
        })
        .await?,
    ))
}

async fn optimize(
    State(pool): State<super::execution::ExecutionPool>,
    headers: HeaderMap,
    payload: Result<Json<OptimizeRequest>, JsonRejection>,
) -> Result<Json<OptimizationResult>, ApiError> {
    let Json(request) = payload?;
    Ok(Json(
        pool.run(computation_id(&headers)?, move || {
            optimization::optimize(&request)
        })
        .await?,
    ))
}

pub(super) fn computation_id(headers: &HeaderMap) -> Result<Option<String>, ApiError> {
    headers
        .get("x-computation-id")
        .map(|value| {
            value.to_str().map(str::to_owned).map_err(|_| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_computation_id",
                    "Invalid computation ID.",
                )
            })
        })
        .transpose()
}

async fn cancel(
    State(pool): State<super::execution::ExecutionPool>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    pool.cancel(&id)?;
    Ok(Json(serde_json::json!({ "status": "cancelling" })))
}
