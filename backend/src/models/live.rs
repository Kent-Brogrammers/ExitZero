use serde::{Deserialize, Serialize};

use super::{AnimationFrame, SimulationResult};

/// One JSON object per line from POST /api/simulate/live. The complete event
/// contains the ordinary result, including the recording used for replay.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SimulationStreamEvent {
    Frame { frame: AnimationFrame },
    Complete { result: SimulationResult },
    Error { error: SimulationStreamError },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SimulationStreamError {
    pub code: String,
    pub message: String,
}
