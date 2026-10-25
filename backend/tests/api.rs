use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use exitzero::{
    api::router,
    models::{BuildingScenario, OptimizationResult, SimulationResult, StressTestResult},
    simulation::simulate,
};
use futures_core::Stream;
use serde_json::{Value, json};
use std::{future::poll_fn, pin::Pin};
use tower::ServiceExt;

#[tokio::test]
async fn live_route_delivers_frames_before_the_final_recording() {
    let mut building: BuildingScenario = serde_json::from_value(building()).unwrap();
    building.max_steps = 2;
    building.time_step_seconds = 0.01;
    let request = Request::post("/api/simulate/live")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&building).unwrap()))
        .unwrap();
    let response = router().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/x-ndjson");
    let mut stream = response.into_body().into_data_stream();
    let first = poll_fn(|cx| Pin::new(&mut stream).poll_next(cx))
        .await
        .unwrap()
        .unwrap();
    let event: Value = serde_json::from_slice(&first).unwrap();
    assert_eq!(event["type"], "frame");
    assert_eq!(event["frame"]["step"], 0);
    // The API remains responsive while a live simulation owns a worker.
    assert_eq!(self::request("/api/health", None).await.0, StatusCode::OK);
    let mut bytes = first.to_vec();
    while let Some(chunk) = poll_fn(|cx| Pin::new(&mut stream).poll_next(cx)).await {
        bytes.extend_from_slice(&chunk.unwrap());
    }
    let events: Vec<Value> = std::str::from_utf8(&bytes)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        events
            .iter()
            .map(|event| event["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["frame", "frame", "complete"]
    );
    assert_eq!(events[1]["frame"]["step"], 2);
    let result: SimulationResult = serde_json::from_value(events[2]["result"].clone()).unwrap();
    result.validate().unwrap();
    let expected: Value =
        serde_json::from_slice(&serde_json::to_vec(&simulate(&building).unwrap()).unwrap())
            .unwrap();
    assert_eq!(serde_json::to_value(&result).unwrap(), expected);
}

#[tokio::test]
async fn live_route_rejects_invalid_buildings_before_opening_a_stream() {
    let mut payload = building();
    payload["walls"][0]["end"]["x"] = json!(100);
    let (status, body) = request("/api/simulate/live", Some(payload)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"]["code"], "validation_error");
}

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
async fn recorded_chat_reaches_api_as_actual_discovery_grouped_share_and_later_relay() {
    // Tiny spawn areas make the sight/range relationships deterministic. This
    // tests the real simulator and HTTP serialization, not a message fixture.
    let mut scenario = json!({
        "width":20,"height":12,
        "walls":[{"id":"north","start":{"x":0,"y":0},"end":{"x":20,"y":0},"thickness":0.2}],
        "doors":[],
        "exits":[
            {"id":"left","wall_id":"north","offset":1,"width":2},
            {"id":"right","wall_id":"north","offset":17,"width":2}
        ],
        "spawn_zones":[
            {"id":"a","x":1.9,"y":0.9,"width":0.2,"height":0.2,"count":1},
            {"id":"b","x":1.9,"y":2.9,"width":0.2,"height":0.2,"count":1},
            {"id":"c","x":2.9,"y":2.4,"width":0.2,"height":0.2,"count":1},
            {"id":"d","x":1.9,"y":4.9,"width":0.2,"height":0.2,"count":1}
        ],
        "blocked_exit_ids":["left"],"obstructions":[],"agent_radius":0.1,
        "time_step_seconds":0.1,"seed":42,"max_steps":500,
        "awareness":{"sight_range_metres":1.5,"communication_range_metres":2.1}
    });
    let (status, body) = request("/api/simulate", Some(scenario.clone())).await;
    assert_eq!(status, StatusCode::OK);
    serde_json::from_value::<SimulationResult>(body.clone())
        .unwrap()
        .validate()
        .unwrap();
    assert_eq!(
        body["communication_events"],
        json!([
            {"step":0,"event_type":"discovery","sender_id":0,"recipient_ids":[],"opening_id":"left","blocked":true},
            {"step":0,"event_type":"shared","sender_id":0,"recipient_ids":[1,2],"opening_id":"left","blocked":true},
            {"step":1,"event_type":"shared","sender_id":1,"recipient_ids":[3],"opening_id":"left","blocked":true}
        ])
    );
    scenario["blocked_exit_ids"] = json!([]);
    let (status, normal) = request("/api/simulate", Some(scenario)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(normal["communication_events"], json!([]));
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

#[tokio::test]
async fn walkable_stair_annotations_do_not_change_simulation_output() {
    let mut plain = building();
    plain["max_steps"] = json!(10);
    let mut marked = plain.clone();
    marked["stair_areas"] = json!([{"id":"stair-area","name":"Single-floor marker","x":0,"y":0,"width":30,"height":20,"orientation_degrees":270}]);
    let (plain_status, plain_result) = request("/api/simulate", Some(plain)).await;
    let (marked_status, marked_result) = request("/api/simulate", Some(marked)).await;
    assert_eq!(plain_status, StatusCode::OK);
    assert_eq!(marked_status, StatusCode::OK, "{marked_result}");
    assert_eq!(
        plain_result, marked_result,
        "walkable metadata must not become a solid obstacle or floor connection"
    );
}

#[tokio::test]
async fn ellipse_segment_door_rounding_does_not_create_phantom_collision_capsules() {
    let mut payload = building();
    let points: Vec<_> = (0..32)
        .map(|index| {
            let angle = index as f64 * std::f64::consts::PI / 16.0;
            json!({"x": 15.0 + 4.0 * angle.cos(), "y": 10.0 + 3.0 * angle.sin()})
        })
        .collect();
    let mut walls: Vec<_> = (0..32)
        .map(|index| json!({"id":format!("e{index}"),"start":points[index],"end":points[(index+1)%32],"thickness":0.2}))
        .collect();
    walls.push(json!({"id":"out","start":{"x":27,"y":5},"end":{"x":27,"y":15},"thickness":0.2}));
    payload["walls"] = json!(walls);
    payload["doors"] = json!([]);
    payload["exits"] = json!([{"id":"exit","wall_id":"out","offset":4,"width":2}]);
    payload["spawn_zones"] = json!([{"id":"s","x":14.5,"y":9.5,"width":1,"height":1,"count":1}]);
    payload["blocked_exit_ids"] = json!([]);
    payload["obstructions"] = json!([]);
    payload["agent_radius"] = json!(0.25);
    payload["time_step_seconds"] = json!(0.1);
    payload["seed"] = json!(42);
    payload["max_steps"] = json!(1000);
    let (status, closed) = request("/api/simulate", Some(payload.clone())).await;
    assert_eq!(status, StatusCode::OK, "{closed}");
    assert_eq!(closed["evacuated"], 0);
    let scenario: BuildingScenario = serde_json::from_value(payload.clone()).unwrap();
    payload["doors"] = json!([0, 31].map(|index| {
        json!({"id":format!("d{index}"),"wall_id":format!("e{index}"),"offset":1e-12,"width":scenario.walls[index].length()-2e-12})
    }));
    let (status, open) = request("/api/simulate", Some(payload)).await;
    assert_eq!(status, StatusCode::OK, "{open}");
    assert_eq!(
        open["status"], "completed",
        "status {}, remaining {}",
        open["status"], open["remaining"]
    );
    assert_eq!(open["evacuated"], 1);
    assert_eq!(open["analytics"]["agents"][0]["route_found"], true);
}

#[tokio::test]
async fn catastrophe_requests_return_real_injury_and_shelter_contracts() {
    for kind in ["fire", "gas_leak", "tornado"] {
        let mut payload = building();
        payload["disaster"] =
            json!({ "kind": kind, "center": {"x": 14.0, "y": 10.0}, "radius": 1.0 });
        payload["tornado_zones"] =
            json!([{ "id": "shelter", "x": 4.0, "y": 4.0, "width": 3.0, "height": 3.0 }]);
        let (status, json) = request("/api/simulate", Some(payload)).await;
        assert_eq!(status, StatusCode::OK, "{kind}: {json}");
        let result: SimulationResult = serde_json::from_value(json).unwrap();
        result.validate().unwrap();
        assert_eq!(
            result.metrics.evacuated + result.metrics.sheltered + result.metrics.remaining,
            result.metrics.total_population
        );
        if kind == "tornado" {
            assert_eq!(result.metrics.evacuated, 0);
        }
    }
    let mut invalid = building();
    invalid["disaster"] =
        json!({ "kind": "tornado", "center": {"x": 5.0, "y": 5.0}, "radius": 1.0 });
    assert_eq!(
        request("/api/simulate", Some(invalid)).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}
