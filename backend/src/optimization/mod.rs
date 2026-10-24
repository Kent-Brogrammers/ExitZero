use crate::{
    models::{OptimizationResult, OptimizeRequest},
    simulation::SimulationError,
};

// TODO(Nick): compare bounded layout candidates using the shared simulation API.
pub fn optimize(request: &OptimizeRequest) -> Result<OptimizationResult, SimulationError> {
    request
        .validate()
        .map_err(SimulationError::InvalidScenario)?;
    Err(SimulationError::NotImplemented)
}
