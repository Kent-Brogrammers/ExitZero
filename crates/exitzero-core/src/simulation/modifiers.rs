//! Static composition and separate, stable random streams. Never consumes placement RNG.
use crate::models::{
    AgentModifierAssignment, AgentModifierParameters as Parameters, AgentModifierRecording,
    BuildingScenario, SpawnZone,
};
use std::collections::BTreeMap;

pub(super) fn resolve(scenario: &BuildingScenario, ids: &[String]) -> Parameters {
    let mut ids = ids.to_vec();
    ids.sort();
    let mut p = Parameters::default();
    for id in ids {
        let m = scenario
            .agent_modifiers
            .iter()
            .find(|m| m.id == id)
            .expect("validated modifier");
        p.speed_multiplier *= m.speed_multiplier;
        p.acceleration_multiplier *= m.acceleration_multiplier;
        p.reaction_delay_seconds += m.reaction_delay_seconds;
        p.hazard_cost_multiplier *= m.hazard_cost_multiplier;
        p.crowd_cost_multiplier *= m.crowd_cost_multiplier;
        p.reassessment_interval_multiplier *= m.reassessment_interval_multiplier;
        p.route_switch_threshold_multiplier *= m.route_switch_threshold_multiplier;
        p.avoidance_priority_multiplier *= m.avoidance_priority_multiplier;
    }
    p.speed_multiplier = p.speed_multiplier.clamp(0.1, 2.0);
    p.acceleration_multiplier = p.acceleration_multiplier.clamp(0.1, 2.0);
    p.reaction_delay_seconds = p.reaction_delay_seconds.clamp(0.0, 30.0);
    p.hazard_cost_multiplier = p.hazard_cost_multiplier.clamp(0.25, 4.0);
    p.crowd_cost_multiplier = p.crowd_cost_multiplier.clamp(0.0, 4.0);
    p.reassessment_interval_multiplier = p.reassessment_interval_multiplier.clamp(0.25, 4.0);
    p.route_switch_threshold_multiplier = p.route_switch_threshold_multiplier.clamp(0.25, 4.0);
    p.avoidance_priority_multiplier = p.avoidance_priority_multiplier.clamp(0.25, 4.0);
    p
}

// FNV-1a UTF-8 source identity, separated by a domain byte and fixed-width ordinal;
// xor the scenario seed, then sample with SplitMix64. Stable across processes.
fn stream(seed: u64, id: &str, domain: u8, ordinal: u32) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in id.bytes().chain([domain]).chain(ordinal.to_le_bytes()) {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    seed ^ hash
}

pub(super) fn assignment(
    scenario: &BuildingScenario,
    id: u32,
    source: &str,
    ordinal: Option<u32>,
    ids: &[String],
) -> AgentModifierAssignment {
    let automatic = scenario.spawn_modifier_ids.as_ref().map(|allowed| {
        let mut allowed = allowed.clone();
        allowed.sort();
        if allowed.is_empty() {
            return vec![];
        }
        let mut random = stream(
            scenario.seed,
            source,
            if ordinal.is_some() { 5 } else { 4 },
            ordinal.unwrap_or(0),
        );
        if super::agent::random_unit(&mut random) >= scenario.personality_fraction.unwrap_or(0.3) {
            return vec![];
        }
        let index = (super::agent::random_unit(&mut random) * allowed.len() as f64) as usize;
        vec![allowed[index].clone()]
    });
    let ids = automatic.as_deref().unwrap_or(ids);
    let mut modifier_ids = ids.to_vec();
    modifier_ids.sort();
    let resolved = resolve(scenario, &modifier_ids);
    let mut random = stream(
        scenario.seed,
        source,
        if ordinal.is_some() { 2 } else { 1 },
        ordinal.unwrap_or(0),
    );
    let variation = scenario.agent_speed_variation.unwrap_or(0.0);
    let speed_variation_multiplier =
        1.0 + variation * (2.0 * super::agent::random_unit(&mut random) - 1.0);
    AgentModifierAssignment {
        id,
        source_id: source.to_owned(),
        source_ordinal: ordinal,
        modifier_ids,
        resolved,
        speed_variation_multiplier,
        uninjured_speed_metres_per_second: super::motion::WALKING_SPEED
            * resolved.speed_multiplier
            * speed_variation_multiplier,
        reaction_steps: (resolved.reaction_delay_seconds / scenario.time_step_seconds)
            .ceil()
            .min(f64::from(u32::MAX)) as u32,
    }
}

pub(super) fn zone_assignments(scenario: &BuildingScenario, zone: &SpawnZone) -> Vec<Vec<String>> {
    let mut assigned = vec![vec![]; zone.count as usize];
    let Some(groups) = &zone.modifier_groups else {
        return assigned;
    };
    let mut canonical: BTreeMap<Vec<String>, u32> = BTreeMap::new();
    for group in groups {
        let mut ids = group.modifier_ids.clone();
        ids.sort();
        *canonical.entry(ids).or_default() += group.count;
    }
    let mut ordinals: Vec<_> = (0..zone.count as usize).collect();
    let mut random = stream(scenario.seed, &zone.id, 3, 0);
    for i in (1..ordinals.len()).rev() {
        let j = (super::agent::random_unit(&mut random) * (i + 1) as f64) as usize;
        ordinals.swap(i, j);
    }
    let mut cursor = 0;
    for (ids, count) in canonical {
        for _ in 0..count {
            assigned[ordinals[cursor]] = ids.clone();
            cursor += 1;
        }
    }
    assigned
}

pub(super) fn recording(
    scenario: &BuildingScenario,
    agents: &[super::agent::Agent],
) -> AgentModifierRecording {
    AgentModifierRecording {
        model_version: "static-modifiers-v1".into(),
        definitions: scenario.agent_modifiers.clone(),
        agents: agents.iter().map(|a| a.modifiers.clone()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignment_seed_derivation_is_fixed_and_domain_separated() {
        assert_eq!(stream(42, "area", 3, 0), 0x1bc5f7171638dadf);
        assert_ne!(stream(42, "area", 1, 0), stream(42, "area", 2, 0));
        assert_ne!(stream(42, "area", 2, 0), stream(42, "area", 2, 1));
    }
}
