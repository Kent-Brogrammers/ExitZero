use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowOpening {
    pub id: String,
    #[serde(
        default,
        deserialize_with = "super::building::deserialize_name",
        skip_serializing_if = "Option::is_none"
    )]
    pub name: Option<String>,
    pub wall_id: String,
    pub offset: f64,
    pub width: f64,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub emergency_escape: Option<WindowEscape>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowEscape {
    pub enabled: bool,
    pub preparation: WindowPreparation,
    pub clear_width_metres: f64,
    pub clear_height_metres: f64,
    pub preparation_seconds: f64,
    pub traversal_seconds: f64,
    pub exterior_side: i8,
    pub exterior_available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowPreparation {
    Open,
    Break,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowEscapeContext {
    pub floor_elevation_metres: f64,
    pub all_agents_can_traverse: bool,
    pub required_clear_height_metres: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowState {
    Intact,
    Opening,
    Breaking,
    Open,
    Broken,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowFrameState {
    pub window_id: String,
    pub state: WindowState,
    pub preparation_ready_step: Option<u32>,
    pub queue_agent_ids: Vec<u32>,
    pub traversing_agent_id: Option<u32>,
    pub traversal_earliest_finish_step: Option<u32>,
    /// Why new crossings cannot start; absent in legacy recordings or when usable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    /// Assigned occupants still walking toward the holding lane.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approaching_agent_ids: Option<Vec<u32>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EscapeRouteKind {
    NormalExit,
    EmergencyWindow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EscapeRoute {
    pub kind: EscapeRouteKind,
    pub opening_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvacuatedByRoute {
    pub normal_exit: u32,
    pub emergency_window: u32,
}

pub(super) fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
