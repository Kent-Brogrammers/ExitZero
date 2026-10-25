use exitzero::api::{router, router_with_frontend};
use std::{env, path::PathBuf};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = env::var("PORT")
        .unwrap_or_else(|_| "3001".into())
        .parse()
        .map_err(|_| "PORT must be a valid port number")?;
    let app = match env::var_os("EXITZERO_FRONTEND_DIR") {
        Some(directory) => {
            let directory = PathBuf::from(directory);
            if !directory.join("index.html").is_file() {
                return Err("EXITZERO_FRONTEND_DIR must contain a built index.html".into());
            }
            router_with_frontend(directory)
        }
        None => router(),
    };
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    println!("ExitZero listening on http://{}", listener.local_addr()?);
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let terminate = async {
        #[cfg(unix)]
        {
            let mut signal =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("could not install SIGTERM handler");
            signal.recv().await;
        }
        #[cfg(not(unix))]
        std::future::pending::<()>().await;
    };
    tokio::select! {
        _ = interrupt => {},
        _ = terminate => {},
    }
}
