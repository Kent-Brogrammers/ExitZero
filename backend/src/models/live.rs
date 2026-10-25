use serde::{Deserialize, Serialize};

use super::{AgentEvent, AnimationFrame, CommunicationEvent, SimulationResult};

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveRunQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveSpeedControl {
    pub speed: u32,
}

/// One JSON object per line from POST /api/simulate/live. The complete event
/// contains the ordinary result, including the recording used for replay.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SimulationStreamEvent {
    Frame {
        frame: AnimationFrame,
    },
    Chat {
        communication_events: Vec<CommunicationEvent>,
        agent_events: Vec<AgentEvent>,
    },
    Complete {
        result: SimulationResult,
    },
    Error {
        error: SimulationStreamError,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SimulationStreamError {
    pub code: String,
    pub message: String,
}
