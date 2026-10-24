use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use exitzero::api::router;
use serde_json::{Value, json};
use tower::ServiceExt;

async fn request(path: &str, payload: Option<Value>) -> (StatusCode, Value) {
    let request = match payload {
        Some(value) => Request::post(path)
            .header("content-type", "application/json")
            .body(Body::from(value.to_string()))
            .unwrap(),
        None => Request::get(path).body(Body::empty()).unwrap(),
    };
    let response = router().oneshot(request).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

fn building() -> Value {
    serde_json::from_str(include_str!("../../shared/examples/building.json")).unwrap()
}

#[tokio::test]
async fn health_returns_expected_contract() {
    let (status, body) = request("/api/health", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"status": "ok", "service": "exitzero"}));
}

#[tokio::test]
async fn valid_computation_requests_return_explicit_501_errors() {
    for (path, payload) in [
        ("/api/simulate", building()),
        (
            "/api/stress-test",
            json!({"building": building(), "config": {"max_scenarios": 10, "block_each_exit": true, "blocked_cell_candidates": []}}),
        ),
        (
            "/api/optimize",
            json!({"building": building(), "max_candidates": 10}),
        ),
    ] {
        let (status, body) = request(path, Some(payload)).await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
        assert_eq!(body["error"]["code"], "not_implemented");
        assert!(body.get("frames").is_none());
    }
}

#[tokio::test]
async fn validation_precedes_not_implemented_for_all_computation_routes() {
    let mut invalid = building();
    invalid["width"] = json!(0);
    for (path, payload) in [
        ("/api/simulate", invalid.clone()),
        (
            "/api/stress-test",
            json!({"building": invalid.clone(), "config": {"max_scenarios": 1, "block_each_exit": true, "blocked_cell_candidates": []}}),
        ),
        (
            "/api/optimize",
            json!({"building": invalid, "max_candidates": 1}),
        ),
        (
            "/api/stress-test",
            json!({"building": building(), "config": {"max_scenarios": 0, "block_each_exit": true, "blocked_cell_candidates": []}}),
        ),
        (
            "/api/stress-test",
            json!({"building": building(), "config": {"max_scenarios": 1, "block_each_exit": false, "blocked_cell_candidates": []}}),
        ),
        (
            "/api/optimize",
            json!({"building": building(), "max_candidates": 101}),
        ),
    ] {
        let (status, body) = request(path, Some(payload)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"]["code"], "validation_error");
    }
}

#[tokio::test]
async fn malformed_json_and_missing_content_type_have_structured_errors() {
    for request in [
        Request::post("/api/simulate")
            .header("content-type", "application/json")
            .body(Body::from("{"))
            .unwrap(),
        Request::post("/api/simulate")
            .body(Body::from("{}"))
            .unwrap(),
    ] {
        let response = router().oneshot(request).await.unwrap();
        assert!(response.status().is_client_error());
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 10000).await.unwrap()).unwrap();
        assert_eq!(body["error"]["code"], "invalid_json");
    }
}

#[tokio::test]
async fn cors_allows_both_documented_vite_origins() {
    for origin in ["http://localhost:5173", "http://127.0.0.1:5173"] {
        let request = Request::builder()
            .method("OPTIONS")
            .uri("/api/simulate")
            .header("origin", origin)
            .header("access-control-request-method", "POST")
            .header("access-control-request-headers", "content-type")
            .body(Body::empty())
            .unwrap();
        let response = router().oneshot(request).await.unwrap();
        assert!(response.status().is_success());
        assert_eq!(response.headers()["access-control-allow-origin"], origin);
    }
}
