use std::path::Path;

use axum::{
    Router,
    extract::Request,
    http::{StatusCode, header},
    response::IntoResponse,
    routing::{any, get},
};
use tower_http::services::{ServeDir, ServeFile};

use super::{router, routes::ApiError};

/// Serve the production frontend alongside the unchanged API and live streams.
pub fn router_with_frontend(directory: impl AsRef<Path>) -> Router {
    let directory = directory.as_ref();
    let index = ServeFile::new(directory.join("index.html"));
    let navigation = get(move |request: Request| {
        let mut index = index.clone();
        async move {
            let path = request.uri().path();
            // Missing assets must return 404, never the SPA's HTML document.
            if path == "/assets"
                || path.starts_with("/assets/")
                || Path::new(path).extension().is_some()
            {
                return StatusCode::NOT_FOUND.into_response();
            }
            match index.try_call(request).await {
                Ok(response) => response.into_response(),
                Err(error) => {
                    eprintln!("Could not serve frontend index: {error}");
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
    });
    router()
        // Keep unknown API routes as JSON errors instead of frontend navigation.
        .route("/api", any(api_not_found))
        .route("/api/{*path}", any(api_not_found))
        .fallback_service(ServeDir::new(directory).fallback(navigation))
        .layer(axum::middleware::map_response(
            |mut response: axum::response::Response| async move {
                if response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .is_some_and(|value| value.as_bytes().starts_with(b"text/html"))
                {
                    response
                        .headers_mut()
                        .insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());
                }
                response
            },
        ))
}

async fn api_not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "route not found")
}
