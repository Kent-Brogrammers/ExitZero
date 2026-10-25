//! Cooperative control for synchronous computation. A scope is local to one
//! blocking worker thread, never a process-wide cancellation flag.
use super::SimulationError;
use serde::Serialize;
use std::{
    cell::RefCell,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone, Default, Debug, Serialize)]
pub struct ComputationProgress {
    pub evaluations_completed: u32,
    pub evaluations_total: u32,
    pub step: u32,
    pub step_limit: u32,
}

#[derive(Default)]
pub struct ComputationControl {
    cancelled: AtomicBool,
    progress: Mutex<ComputationProgress>,
    notification: tokio::sync::Notify,
}

thread_local! {
    static CURRENT: RefCell<Option<Arc<ComputationControl>>> = const { RefCell::new(None) };
}

impl ComputationControl {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notification.notify_one();
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    pub fn progress(&self) -> ComputationProgress {
        self.progress.lock().unwrap().clone()
    }
    pub(crate) async fn cancellation(&self) {
        loop {
            let notified = self.notification.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }

    pub fn run<T>(
        self: &Arc<Self>,
        work: impl FnOnce() -> Result<T, SimulationError>,
    ) -> Result<T, SimulationError> {
        struct Restore(Option<Arc<ComputationControl>>);
        impl Drop for Restore {
            fn drop(&mut self) {
                CURRENT.with(|c| c.replace(self.0.take()));
            }
        }
        let _restore = Restore(CURRENT.with(|c| c.replace(Some(self.clone()))));
        checkpoint()?;
        let result = work()?;
        checkpoint()?;
        Ok(result)
    }
}

pub(crate) fn cancelled() -> bool {
    CURRENT.with(|c| c.borrow().as_ref().is_some_and(|c| c.is_cancelled()))
}
pub(crate) fn checkpoint() -> Result<(), SimulationError> {
    if cancelled() {
        Err(SimulationError::Cancelled)
    } else {
        Ok(())
    }
}
pub(crate) fn plan(evaluations: usize) {
    CURRENT.with(|c| {
        if let Some(c) = c.borrow().as_ref() {
            *c.progress.lock().unwrap() = ComputationProgress {
                evaluations_total: evaluations as u32,
                ..Default::default()
            };
        }
    });
}
pub(crate) fn evaluation_finished() {
    CURRENT.with(|c| {
        if let Some(c) = c.borrow().as_ref() {
            c.progress.lock().unwrap().evaluations_completed += 1;
        }
    });
}
pub(crate) fn step(step: u32, limit: u32) {
    CURRENT.with(|c| {
        if let Some(c) = c.borrow().as_ref() {
            let mut p = c.progress.lock().unwrap();
            p.step = step;
            p.step_limit = limit;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_during_real_physics_is_not_success_and_does_not_leak() {
        let building =
            serde_json::from_str(include_str!("../../../shared/examples/building.json")).unwrap();
        let control = Arc::new(ComputationControl::default());
        let result = control.run(|| {
            super::super::simulate_live(&building, &mut |frame| {
                if frame.step > 0 {
                    control.cancel();
                }
                true
            })
        });
        assert!(matches!(result, Err(SimulationError::Cancelled)));
        assert!(control.progress().step > 0);
        control.cancel(); // Idempotent, and the next independent scope still works.
        let independent = Arc::new(ComputationControl::default());
        let actual = independent
            .run(|| super::super::simulate(&building))
            .unwrap();
        let expected = super::super::simulate(&building).unwrap();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }
}
