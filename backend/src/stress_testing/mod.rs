use crate::{
    models::{StressTestRequest, StressTestResult},
    simulation::SimulationError,
};

// TODO(Nick): generate scenarios and call crate::simulation::simulate for each.
pub fn stress_test(request: &StressTestRequest) -> Result<StressTestResult, SimulationError> {
    request
        .validate()
        .map_err(SimulationError::InvalidScenario)?;
    Err(SimulationError::NotImplemented)
}
