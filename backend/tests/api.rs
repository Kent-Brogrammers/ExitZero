use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use exitzero::{
    api::router,
    models::{BuildingScenario, OptimizationResult, SimulationResult, StressTestResult},
    simulation::simulate,
};
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
async fn valid_computation_requests_return_real_results_matching_the_simulator() {
    let building: BuildingScenario = serde_json::from_value(building()).unwrap();
    let baseline = simulate(&building).unwrap();
    baseline.validate().unwrap();
    // Normalize the direct result through the same JSON parsing used by HTTP.
    // Default JSON float parsing can round a coordinate by one ULP; this is
    // separate from exact in-process spawning/fairness checks in the modules.
    let transported_baseline: SimulationResult =
        serde_json::from_slice(&serde_json::to_vec(&baseline).unwrap()).unwrap();
    let expected = serde_json::to_value(&baseline.metrics).unwrap();
    for (path, payload) in [
        ("/api/simulate", serde_json::to_value(&building).unwrap()),
        (
            "/api/stress-test",
            json!({"building": building, "config": {"max_scenarios": 10, "block_each_exit": true, "obstruction_candidates": []}}),
        ),
        (
            "/api/optimize",
            json!({"building": building, "max_candidates": 10}),
        ),
    ] {
        let (status, body) = request(path, Some(payload)).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert!(body.get("error").is_none());
        match path {
            "/api/simulate" => {
                let result: SimulationResult = serde_json::from_value(body).unwrap();
                result.validate().unwrap();
                assert_eq!(serde_json::to_value(result.metrics).unwrap(), expected);
                assert_eq!(result.frames.len(), transported_baseline.frames.len());
                for (actual, expected) in result.frames.iter().zip(&transported_baseline.frames) {
                    assert_eq!(actual.step, expected.step);
                    assert_eq!(actual.agents.len(), expected.agents.len());
                    for (actual, expected) in actual.agents.iter().zip(&expected.agents) {
                        assert_eq!(
                            (actual.id, actual.x, actual.y),
                            (expected.id, expected.x, expected.y)
                        );
                    }
                }
            }
            "/api/stress-test" => {
                let result: StressTestResult = serde_json::from_value(body).unwrap();
                assert_eq!(serde_json::to_value(result.baseline).unwrap(), expected);
                assert_eq!(result.scenarios.len(), building.exits.len());
                for scenario in result.scenarios {
                    scenario.metrics.validate().unwrap();
                    assert!(scenario.description.contains("fairness verified"));
                }
            }
            "/api/optimize" => {
                let result: OptimizationResult = serde_json::from_value(body).unwrap();
                assert_eq!(serde_json::to_value(&result.baseline).unwrap(), expected);
                assert!(result.candidates.len() <= 10);
                for candidate in result.candidates {
                    candidate.building.validate().unwrap();
                    candidate.metrics.validate().unwrap();
                    assert!(candidate.metrics.compare_severity(&result.baseline).is_lt());
                }
            }
            _ => unreachable!(),
        }
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
            json!({"building": invalid.clone(), "config": {"max_scenarios": 1, "block_each_exit": true, "obstruction_candidates": []}}),
        ),
        (
            "/api/optimize",
            json!({"building": invalid, "max_candidates": 1}),
        ),
        (
            "/api/stress-test",
            json!({"building": building(), "config": {"max_scenarios": 0, "block_each_exit": true, "obstruction_candidates": []}}),
        ),
        (
            "/api/stress-test",
            json!({"building": building(), "config": {"max_scenarios": 1, "block_each_exit": false, "obstruction_candidates": []}}),
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

#[tokio::test]
async fn names_are_transport_metadata_and_do_not_change_evacuation_output() {
    let mut original = building();
    original["max_steps"] = json!(10);
    original["obstructions"] = json!([{"id":"footprint","x":20,"y":8,"width":1,"height":1}]);
    original["blocked_exit_ids"] = json!(["west"]);
    let mut named = original.clone();
    for field in ["walls", "doors", "exits", "spawn_zones", "obstructions"] {
        for (index, element) in named[field].as_array_mut().unwrap().iter_mut().enumerate() {
            element["name"] = json!(format!("Custom {field} {index}"));
        }
    }
    let (plain_status, plain_result) = request("/api/simulate", Some(original)).await;
    let (named_status, named_result) = request("/api/simulate", Some(named)).await;
    assert_eq!(plain_status, StatusCode::OK);
    assert_eq!(named_status, StatusCode::OK, "{named_result}");
    assert_eq!(
        named_result, plain_result,
        "display names must not affect frames, traffic, metrics, or agent statistics"
    );
}

#[tokio::test]
async fn api_rejects_invalid_names_instead_of_silently_losing_them() {
    for name in [json!("   "), json!("x".repeat(81)), Value::Null] {
        let mut named = building();
        named["walls"][0]["name"] = name;
        let (status, body) = request("/api/simulate", Some(named)).await;
        assert!(status.is_client_error(), "{body}");
    }
}
