use crate::models::{BuildingScenario, SimulationResult};
use std::fmt;

#[derive(Debug)]
pub enum SimulationError {
    InvalidScenario(String),
    NotImplemented,
}

impl fmt::Display for SimulationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidScenario(message) => write!(f, "{message}"),
            Self::NotImplemented => write!(f, "simulation engine is not implemented"),
        }
    }
}

impl std::error::Error for SimulationError {}

// TODO(Connor): deterministic movement, navigation, frames, and metrics.
pub fn simulate(scenario: &BuildingScenario) -> Result<SimulationResult, SimulationError> {
    scenario
        .validate()
        .map_err(SimulationError::InvalidScenario)?;
    Err(SimulationError::NotImplemented)
}
