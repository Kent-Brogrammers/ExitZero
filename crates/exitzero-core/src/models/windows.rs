use serde::{Deserialize, Serialize};
use std::borrow::Cow;

impl super::BuildingScenario {
    /// Old layouts receive the same usable-window defaults as the editor.
    /// Explicit escape settings and scenario capability overrides remain intact.
    pub fn with_window_escape_defaults(&self) -> Cow<'_, Self> {
        let missing_window = self
            .windows
            .iter()
            .any(|window| window.emergency_escape.is_none());
        let missing_context = self.window_escape_context.is_none()
            && self.windows.iter().any(|window| {
                window
                    .emergency_escape
                    .as_ref()
                    .is_none_or(|escape| escape.enabled)
            });
        if !missing_window && !missing_context {
            return Cow::Borrowed(self);
        }
        let mut ready = self.clone();
        if missing_context {
            ready.window_escape_context = Some(WindowEscapeContext {
                floor_elevation_metres: 0.0,
                all_agents_can_traverse: true,
                required_clear_height_metres: 1.0,
            });
        }
        for window in &mut ready.windows {
            if window.emergency_escape.is_some() {
                continue;
            }
            window.emergency_escape = Some(WindowEscape {
                enabled: true,
                preparation: WindowPreparation::Break,
                clear_width_metres: window.width,
                clear_height_metres: self
                    .window_escape_context
                    .as_ref()
                    .map_or(1.2, |context| context.required_clear_height_metres.max(1.2)),
                preparation_seconds: 5.0,
                traversal_seconds: 3.0,
                exterior_side: default_exterior_side(self, window),
                exterior_available: true,
            });
        }
        Cow::Owned(ready)
    }
}

fn default_exterior_side(scenario: &super::BuildingScenario, window: &WindowOpening) -> i8 {
    let Some(wall) = scenario.walls.iter().find(|wall| wall.id == window.wall_id) else {
        return -1;
    };
    let dx = wall.end.x - wall.start.x;
    let dy = wall.end.y - wall.start.y;
    let mut occupied_side = 0;
    let mut ambiguous = false;
    for zone in scenario.spawn_zones.iter().filter(|zone| zone.count > 0) {
        for x in [zone.x, zone.x + zone.width] {
            for y in [zone.y, zone.y + zone.height] {
                let distance = ((x - wall.start.x) * -dy + (y - wall.start.y) * dx) / wall.length();
                let side = if distance >= 0.0 { 1 } else { -1 };
                if distance.abs() <= wall.thickness / 2.0
                    || (occupied_side != 0 && side != occupied_side)
                {
                    ambiguous = true;
                }
                occupied_side = side;
            }
        }
    }
    for person in &scenario.placed_occupants {
        let distance =
            ((person.x - wall.start.x) * -dy + (person.y - wall.start.y) * dx) / wall.length();
        let side = if distance >= 0.0 { 1 } else { -1 };
        if distance.abs() <= wall.thickness / 2.0 + scenario.agent_radius
            || (occupied_side != 0 && side != occupied_side)
        {
            ambiguous = true;
        }
        occupied_side = side;
    }
    if !ambiguous && occupied_side != 0 {
        return -occupied_side;
    }
    let (mut x, mut y, mut weight) = (0.0, 0.0, 0.0);
    for other in scenario.walls.iter().filter(|other| other.id != wall.id) {
        let length = other.length();
        x += (other.start.x + other.end.x) / 2.0 * length;
        y += (other.start.y + other.end.y) / 2.0 * length;
        weight += length;
    }
    let center = if weight > 0.0 {
        (x / weight, y / weight)
    } else {
        (scenario.width / 2.0, scenario.height / 2.0)
    };
    if (center.0 - wall.start.x) * -dy + (center.1 - wall.start.y) * dx >= 0.0 {
        -1
    } else {
        1
    }
}

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

/// The comparison actually used when an occupant commits to a window. These
/// are subjective remaining-time estimates, never measured escape outcomes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowDecision {
    pub step: u32,
    pub agent_id: u32,
    pub window_id: String,
    pub reason: WindowDecisionReason,
    pub estimated_window_seconds: f64,
    pub estimated_exit_seconds: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowDecisionReason {
    EstimatedFaster,
    NoKnownSafeExit,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowDecisionHistory {
    pub choices: Vec<WindowDecision>,
    pub truncated: bool,
}

impl WindowDecisionHistory {
    pub const MAX_CHOICES: usize = 20_000;

    pub(crate) fn record(&mut self, decision: WindowDecision) {
        // Two service updates can occur at one timestamp. Keep the final
        // assignment for each person/tick, including an immediate reassignment.
        if let Some(previous) = self
            .choices
            .iter_mut()
            .rev()
            .take_while(|choice| choice.step == decision.step)
            .find(|choice| choice.agent_id == decision.agent_id)
        {
            *previous = decision;
            return;
        }
        if self.choices.len() < Self::MAX_CHOICES {
            self.choices.push(decision);
        } else {
            self.truncated = true;
        }
    }
}

pub(super) fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod decision_tests {
    use super::*;
    fn choice(step: u32, window: &str) -> WindowDecision {
        WindowDecision {
            step,
            agent_id: 0,
            window_id: window.into(),
            reason: WindowDecisionReason::EstimatedFaster,
            estimated_window_seconds: 5.0,
            estimated_exit_seconds: Some(20.0),
        }
    }
    #[test]
    fn assignments_are_deduplicated_per_timestamp_and_recording_is_bounded() {
        let mut history = WindowDecisionHistory::default();
        history.record(choice(0, "first"));
        history.record(choice(0, "replacement"));
        assert_eq!(history.choices.len(), 1);
        assert_eq!(history.choices[0].window_id, "replacement");
        for step in 1..=WindowDecisionHistory::MAX_CHOICES as u32 {
            history.record(choice(step, "pane"));
        }
        assert_eq!(history.choices.len(), WindowDecisionHistory::MAX_CHOICES);
        assert!(history.truncated);
    }
}
