use super::routes::ApiError;
use crate::simulation::{ComputationControl, SimulationError};
use axum::http::StatusCode;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Clone)]
pub(crate) struct ExecutionPool {
    workers: Arc<Semaphore>,
    admission: Arc<Semaphore>,
    registry: Arc<Mutex<Registry>>,
}

#[derive(Default)]
struct Registry {
    active: HashMap<String, Arc<ComputationControl>>,
    // Remember Stop arriving before its POST, without retaining finished work.
    cancelled: HashMap<String, Instant>,
}

pub(crate) struct Execution {
    pub control: Arc<ComputationControl>,
    id: String,
    registry: Arc<Mutex<Registry>>,
    _admission: OwnedSemaphorePermit,
}
impl Drop for Execution {
    fn drop(&mut self) {
        self.registry.lock().unwrap().active.remove(&self.id);
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub struct CancelOnDrop(pub Arc<ComputationControl>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl ExecutionPool {
    pub(crate) fn new(workers: usize, queued: usize) -> Self {
        Self {
            workers: Arc::new(Semaphore::new(workers)),
            admission: Arc::new(Semaphore::new(workers + queued)),
            registry: Arc::new(Mutex::new(Registry::default())),
        }
    }
    pub(crate) fn admit(&self) -> Result<OwnedSemaphorePermit, ApiError> {
        self.admission.clone().try_acquire_owned().map_err(|_| {
            ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "queue_full",
                "The computation queue is full. Cancel a task or retry after one finishes.",
            )
        })
    }
    pub(crate) fn begin(&self, id: Option<String>) -> Result<Execution, ApiError> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = id.unwrap_or_else(|| format!("server-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
        if !valid_id(&id) {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_computation_id",
                "Invalid computation ID.",
            ));
        }
        let admission = self.admit()?;
        let control = Arc::new(ComputationControl::default());
        let mut registry = self.registry.lock().unwrap();
        registry
            .cancelled
            .retain(|_, expires| *expires > Instant::now());
        if registry.cancelled.contains_key(&id) {
            return Err(SimulationError::Cancelled.into());
        }
        if registry.active.contains_key(&id) {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "duplicate_computation_id",
                "This computation ID is already active.",
            ));
        }
        registry.active.insert(id.clone(), control.clone());
        Ok(Execution {
            control,
            id,
            registry: self.registry.clone(),
            _admission: admission,
        })
    }
    pub(crate) fn cancel(&self, id: &str) -> Result<(), ApiError> {
        if !valid_id(id) {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_computation_id",
                "Invalid computation ID.",
            ));
        }
        let mut registry = self.registry.lock().unwrap();
        registry
            .cancelled
            .retain(|_, expires| *expires > Instant::now());
        if let Some(control) = registry.active.get(id) {
            control.cancel();
        }
        if !registry.cancelled.contains_key(id) && registry.cancelled.len() >= 64 {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "cancellation_limit",
                "Too many recent cancellations. Retry shortly.",
            ));
        }
        registry
            .cancelled
            .insert(id.into(), Instant::now() + Duration::from_secs(60));
        Ok(())
    }
    pub(crate) async fn acquire(
        &self,
        control: &ComputationControl,
    ) -> Result<OwnedSemaphorePermit, ApiError> {
        tokio::select! {
            biased;
            _ = control.cancellation() => Err(SimulationError::Cancelled.into()),
            permit = self.workers.clone().acquire_owned() => Ok(permit.expect("execution pool stays open")),
        }
    }
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        id: Option<String>,
        work: impl FnOnce() -> Result<T, SimulationError> + Send + 'static,
    ) -> Result<T, ApiError> {
        let execution = self.begin(id)?;
        let control = execution.control.clone();
        let _cancel = CancelOnDrop(control.clone());
        let permit = self.acquire(&control).await?;
        tokio::task::spawn_blocking(move || {
            let _permits = (execution, permit);
            control.run(work)
        })
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "worker_failed",
                "The computation worker failed.",
            )
        })?
        .map_err(ApiError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn queued_cancellation_is_immediate_isolated_and_cleaned_up() {
        let pool = ExecutionPool::new(1, 1);
        let active = pool.begin(Some("active".into())).unwrap();
        let worker = pool.acquire(&active.control).await.unwrap();
        let queued = tokio::spawn({
            let pool = pool.clone();
            async move { pool.run(Some("queued".into()), || Ok(123)).await }
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !pool.registry.lock().unwrap().active.contains_key("queued") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(pool.admit().is_err());
        assert!(pool.begin(Some("active".into())).is_err());
        pool.cancel("queued").unwrap();
        pool.cancel("queued").unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(2), queued)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(!active.control.is_cancelled());
        assert!(!pool.registry.lock().unwrap().active.contains_key("queued"));
        // Cancellation wins even if its POST arrived before the work POST.
        pool.cancel("not-started").unwrap();
        assert!(pool.begin(Some("not-started".into())).is_err());
        drop((worker, active));
        assert!(pool.registry.lock().unwrap().active.is_empty());
        assert_eq!(pool.run(None, || Ok(42)).await.unwrap(), 42);
        assert!(pool.registry.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn abandoned_request_stops_actual_work_and_releases_worker_capacity() {
        let pool = ExecutionPool::new(1, 1);
        let ticks = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn({
            let pool = pool.clone();
            let ticks = ticks.clone();
            async move {
                pool.run(None, move || -> Result<(), SimulationError> {
                    loop {
                        crate::simulation::control::checkpoint()?;
                        ticks.fetch_add(1, Ordering::Relaxed);
                        std::thread::sleep(Duration::from_millis(1));
                    }
                })
                .await
            }
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while ticks.load(Ordering::Relaxed) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // The sole worker is occupied, but the async runtime remains responsive.
        let queued = pool.admit().unwrap();
        assert!(pool.admit().is_err());
        drop(queued);
        task.abort();
        let _ = task.await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), pool.run(None, || Ok(42)))
                .await
                .unwrap()
                .unwrap(),
            42
        );
        let stopped_at = ticks.load(Ordering::Relaxed);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(ticks.load(Ordering::Relaxed), stopped_at);
    }
}
