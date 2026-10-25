use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use exitzero::api::router_with_frontend;
use futures_core::Stream;
use serde_json::{Value, json};
use std::{
    future::poll_fn,
    path::PathBuf,
    pin::Pin,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tower::ServiceExt;

struct Frontend(PathBuf);

impl Frontend {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let directory = std::env::temp_dir().join(format!(
            "exitzero-frontend-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(directory.join("assets")).unwrap();
        std::fs::write(directory.join("index.html"), "<h1>ExitZero Studio</h1>").unwrap();
        std::fs::write(directory.join("assets/app.js"), "console.log('studio');").unwrap();
        Self(directory)
    }
}

impl Drop for Frontend {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn frontend_serves_navigation_assets_head_and_ranges() {
    let frontend = Frontend::new();
    let app = router_with_frontend(&frontend.0);
    for path in ["/", "/templates", "/studio/simulation"] {
        let response = app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(response.headers()["content-type"], "text/html");
        assert_eq!(response.headers()["cache-control"], "no-cache");
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap(),
            "<h1>ExitZero Studio</h1>"
        );
    }
    let response = app
        .clone()
        .oneshot(Request::head("/templates").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        to_bytes(response.into_body(), 1024)
            .await
            .unwrap()
            .is_empty()
    );

    let response = app
        .oneshot(
            Request::get("/assets/app.js")
                .header("range", "bytes=0-6")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert!(
        response.headers()["content-type"]
            .to_str()
            .unwrap()
            .contains("javascript")
    );
    assert_eq!(
        to_bytes(response.into_body(), 1024).await.unwrap(),
        "console"
    );
}

#[tokio::test]
async fn api_and_missing_assets_never_receive_the_spa_document() {
    let frontend = Frontend::new();
    let app = router_with_frontend(&frontend.0);
    let health = app
        .clone()
        .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    let body = to_bytes(health.into_body(), 1024).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["status"],
        "ok"
    );
    for path in ["/api", "/api/unknown", "/api/simulate/unknown"] {
        for method in ["GET", "POST"] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{method} {path}");
            assert_eq!(response.headers()["content-type"], "application/json");
        }
    }
    for path in [
        "/assets/missing.js",
        "/assets/missing",
        "/audio/missing.wav",
        "/missing.css",
        "/../Cargo.toml",
    ] {
        let response = app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
    let response = app
        .oneshot(Request::post("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(response.headers()["content-type"], "application/json");
}

#[tokio::test]
async fn production_router_keeps_batch_and_live_simulation_working() {
    let frontend = Frontend::new();
    let app = router_with_frontend(&frontend.0);
    let mut building: Value =
        serde_json::from_str(include_str!("../../shared/examples/building.json")).unwrap();
    building["max_steps"] = json!(2);
    building["time_step_seconds"] = json!(0.01);
    let request = |path| {
        Request::post(path)
            .header("content-type", "application/json")
            .body(Body::from(building.to_string()))
            .unwrap()
    };
    let batch = app.clone().oneshot(request("/api/simulate")).await.unwrap();
    assert_eq!(batch.status(), StatusCode::OK);
    let body = to_bytes(batch.into_body(), 1_000_000).await.unwrap();
    let batch: Value = serde_json::from_slice(&body).unwrap();
    assert!(!batch["frames"].as_array().unwrap().is_empty());

    let response = app.oneshot(request("/api/simulate/live")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/x-ndjson");
    let mut stream = response.into_body().into_data_stream();
    let first = tokio::time::timeout(
        Duration::from_secs(2),
        poll_fn(|cx| Pin::new(&mut stream).poll_next(cx)),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&first).unwrap()["type"],
        "frame"
    );
    let mut recording = first.to_vec();
    while let Some(chunk) = poll_fn(|cx| Pin::new(&mut stream).poll_next(cx)).await {
        recording.extend_from_slice(&chunk.unwrap());
    }
    let last: Value = serde_json::from_str(
        std::str::from_utf8(&recording)
            .unwrap()
            .lines()
            .last()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(last["type"], "complete");
    assert_eq!(last["result"], batch);
}
