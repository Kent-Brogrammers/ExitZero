use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

fn one() -> f64 {
    1.0
}

/// Illustrative experiment parameters, independent of labels and hazard injury.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentModifierParameters {
    pub speed_multiplier: f64,
    pub acceleration_multiplier: f64,
    pub reaction_delay_seconds: f64,
    pub hazard_cost_multiplier: f64,
    pub crowd_cost_multiplier: f64,
    pub reassessment_interval_multiplier: f64,
    pub route_switch_threshold_multiplier: f64,
    /// Higher priority gives the other moving person more avoidance responsibility.
    pub avoidance_priority_multiplier: f64,
}

impl Default for AgentModifierParameters {
    fn default() -> Self {
        Self {
            speed_multiplier: one(),
            acceleration_multiplier: one(),
            reaction_delay_seconds: 0.0,
            hazard_cost_multiplier: one(),
            crowd_cost_multiplier: one(),
            reassessment_interval_multiplier: one(),
            route_switch_threshold_multiplier: one(),
            avoidance_priority_multiplier: one(),
        }
    }
}

impl AgentModifierParameters {
    pub fn validate(&self) -> Result<(), String> {
        for (name, value, min, max) in [
            ("speed_multiplier", self.speed_multiplier, 0.1, 2.0),
            (
                "acceleration_multiplier",
                self.acceleration_multiplier,
                0.1,
                2.0,
            ),
            (
                "reaction_delay_seconds",
                self.reaction_delay_seconds,
                0.0,
                30.0,
            ),
            (
                "hazard_cost_multiplier",
                self.hazard_cost_multiplier,
                0.25,
                4.0,
            ),
            (
                "crowd_cost_multiplier",
                self.crowd_cost_multiplier,
                0.0,
                4.0,
            ),
            (
                "reassessment_interval_multiplier",
                self.reassessment_interval_multiplier,
                0.25,
                4.0,
            ),
            (
                "route_switch_threshold_multiplier",
                self.route_switch_threshold_multiplier,
                0.25,
                4.0,
            ),
            (
                "avoidance_priority_multiplier",
                self.avoidance_priority_multiplier,
                0.25,
                4.0,
            ),
        ] {
            if !value.is_finite() || value < min || value > max {
                return Err(format!("{name} must be finite and between {min} and {max}"));
            }
        }
        Ok(())
    }
}

// Spell out fields instead of serde flatten so unknown parameter names are rejected.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentModifier {
    #[serde(default)]
    pub requires_emergency_discovery: bool,
    pub id: String,
    pub name: String,
    #[serde(default = "one")]
    pub speed_multiplier: f64,
    #[serde(default = "one")]
    pub acceleration_multiplier: f64,
    #[serde(default)]
    pub reaction_delay_seconds: f64,
    #[serde(default = "one")]
    pub hazard_cost_multiplier: f64,
    #[serde(default = "one")]
    pub crowd_cost_multiplier: f64,
    #[serde(default = "one")]
    pub reassessment_interval_multiplier: f64,
    #[serde(default = "one")]
    pub route_switch_threshold_multiplier: f64,
    #[serde(default = "one")]
    pub avoidance_priority_multiplier: f64,
}

impl AgentModifier {
    pub fn parameters(&self) -> AgentModifierParameters {
        AgentModifierParameters {
            speed_multiplier: self.speed_multiplier,
            acceleration_multiplier: self.acceleration_multiplier,
            reaction_delay_seconds: self.reaction_delay_seconds,
            hazard_cost_multiplier: self.hazard_cost_multiplier,
            crowd_cost_multiplier: self.crowd_cost_multiplier,
            reassessment_interval_multiplier: self.reassessment_interval_multiplier,
            route_switch_threshold_multiplier: self.route_switch_threshold_multiplier,
            avoidance_priority_multiplier: self.avoidance_priority_multiplier,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentModifierGroup {
    pub count: u32,
    pub modifier_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentModifierAssignment {
    pub id: u32,
    pub source_id: String,
    pub source_ordinal: Option<u32>,
    pub modifier_ids: Vec<String>,
    pub resolved: AgentModifierParameters,
    pub speed_variation_multiplier: f64,
    pub uninjured_speed_metres_per_second: f64,
    pub reaction_steps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentModifierRecording {
    pub model_version: String,
    pub definitions: Vec<AgentModifier>,
    pub agents: Vec<AgentModifierAssignment>,
}

pub(super) fn validate_definitions(definitions: &[AgentModifier]) -> Result<(), String> {
    if definitions.len() > 64 {
        return Err("at most 64 agent modifiers are supported".into());
    }
    let mut ids = BTreeSet::new();
    for modifier in definitions {
        if modifier.id.trim().is_empty()
            || modifier.id.chars().count() > 64
            || !ids.insert(&modifier.id)
            || modifier.name.trim().is_empty()
            || modifier.name.chars().count() > 80
        {
            return Err(
                "agent modifiers require unique nonblank IDs (max 64) and names (max 80)".into(),
            );
        }
        modifier.parameters().validate()?;
    }
    Ok(())
}

pub(super) fn validate_scenario(scenario: &super::BuildingScenario) -> Result<(), String> {
    validate_definitions(&scenario.agent_modifiers)?;
    if scenario
        .personality_fraction
        .is_some_and(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
    {
        return Err("personality_fraction must be between 0 and 1".into());
    }
    if scenario
        .agent_speed_variation
        .is_some_and(|v| !v.is_finite() || !(0.0..=0.2).contains(&v))
    {
        return Err("agent_speed_variation must be between 0 and 0.2".into());
    }
    let definitions: BTreeMap<_, _> = scenario
        .agent_modifiers
        .iter()
        .map(|m| (&m.id, m))
        .collect();
    let validate_ids = |ids: &[String]| -> Result<(), String> {
        let unique: BTreeSet<_> = ids.iter().collect();
        if ids.len() > 64
            || unique.len() != ids.len()
            || ids.iter().any(|id| !definitions.contains_key(id))
        {
            return Err("modifier assignments require known, distinct IDs (max 64)".into());
        }
        if scenario.pursuit.is_some()
            && ids.iter().any(|id| {
                definitions[id].parameters() != AgentModifierParameters::default()
                    || definitions[id].requires_emergency_discovery
            })
        {
            return Err("Pursuit does not support active nonneutral agent modifiers".into());
        }
        Ok(())
    };
    if let Some(ids) = &scenario.spawn_modifier_ids {
        validate_ids(ids)?;
        if scenario
            .placed_occupants
            .iter()
            .any(|p| !p.modifier_ids.is_empty())
            || scenario
                .spawn_zones
                .iter()
                .any(|z| z.modifier_groups.is_some())
        {
            return Err("automatic spawn modifiers cannot be combined with explicit occupant or zone assignments".into());
        }
    }
    for occupant in &scenario.placed_occupants {
        validate_ids(&occupant.modifier_ids)?;
    }
    for zone in &scenario.spawn_zones {
        if let Some(groups) = &zone.modifier_groups {
            if groups.is_empty()
                || groups.len() as u64 > u64::from(zone.count)
                || groups.iter().any(|g| g.count == 0)
                || groups.iter().map(|g| u64::from(g.count)).sum::<u64>() != u64::from(zone.count)
            {
                return Err(format!(
                    "modifier_groups for '{}' must be nonempty, positive, and sum to its occupant count",
                    zone.id
                ));
            }
            for group in groups {
                validate_ids(&group.modifier_ids)?;
            }
        }
    }
    if scenario.pursuit.is_some() && scenario.agent_speed_variation.is_some_and(|v| v != 0.0) {
        return Err("Pursuit does not support agent speed variation".into());
    }
    Ok(())
}
