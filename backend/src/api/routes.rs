use axum::{
    Json, Router,
    extract::rejection::JsonRejection,
    http::{HeaderValue, Method, StatusCode},
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
    Router::new()
        .route("/api/health", get(health))
        .route("/api/simulate", post(simulate))
        .merge(super::live::router())
        .route("/api/stress-test", post(stress_test))
        .route("/api/optimize", post(optimize))
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "not_found", "route not found") })
        .method_not_allowed_fallback(|| async {
            ApiError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                "method not allowed",
            )
        })
        .layer(
            CorsLayer::new()
                .allow_origin([
                    HeaderValue::from_static("http://localhost:5173"),
                    HeaderValue::from_static("http://127.0.0.1:5173"),
                ])
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([axum::http::header::CONTENT_TYPE]),
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
pub(super) struct ApiError {
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
    pub(super) fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
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
    payload: Result<Json<BuildingScenario>, JsonRejection>,
) -> Result<Json<SimulationResult>, ApiError> {
    let Json(building) = payload?;
    Ok(Json(simulation::simulate(&building)?))
}

async fn stress_test(
    payload: Result<Json<StressTestRequest>, JsonRejection>,
) -> Result<Json<StressTestResult>, ApiError> {
    let Json(request) = payload?;
    Ok(Json(stress_testing::stress_test(&request)?))
}

async fn optimize(
    payload: Result<Json<OptimizeRequest>, JsonRejection>,
) -> Result<Json<OptimizationResult>, ApiError> {
    let Json(request) = payload?;
    Ok(Json(optimization::optimize(&request)?))
}
