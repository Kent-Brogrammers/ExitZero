use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentAwareness {
    pub sight_range_metres: f64,
    pub communication_range_metres: f64,
}

impl Default for AgentAwareness {
    fn default() -> Self {
        Self {
            sight_range_metres: 8.0,
            communication_range_metres: 3.0,
        }
    }
}

impl AgentAwareness {
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

/// Runtime input for an opening's physical state; IDs may reference doors or
/// exits. Future hazard logic can produce the same changes as this schedule.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpeningStateChange {
    pub step: u32,
    pub opening_id: String,
    pub blocked: bool,
}
