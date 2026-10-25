use super::{SimulationError, geometry::Geometry, math};
use super::{awareness::Observation, perception::WallKnowledge};
use crate::models::{BuildingScenario, Point};
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct Agent {
    pub id: u32,
    pub position: Point,
    /// Missing entries mean assumed open, never privileged access to the world.
    pub knowledge: BTreeMap<String, Observation>,
    // Emergency indices are stable for the immutable input of this run.
    pub known_emergencies: BTreeSet<usize>,
    pub known_obstructions: BTreeSet<String>,
    pub known_walls: WallKnowledge,
    pub knows_disaster: bool,
    pub known_hazards: BTreeMap<u32, crate::models::HazardArea>,
    pub injury: f64,
    pub exposure_seconds: f64,
    pub sheltered: bool,
}

impl Agent {
    pub(super) fn new(id: u32, position: Point) -> Self {
        Self {
            id,
            position,
            knowledge: BTreeMap::new(),
            known_emergencies: BTreeSet::new(),
            known_obstructions: BTreeSet::new(),
            known_walls: WallKnowledge::new(),
            knows_disaster: false,
            known_hazards: BTreeMap::new(),
            injury: 0.0,
            exposure_seconds: 0.0,
            sheltered: false,
        }
    }
}

/// Populate an empty vector from a validated scenario. Leave it unchanged if
/// placement fails; a bounded search failure does not prove packing impossible.
pub(super) fn spawn_agents(
    agents: &mut Vec<Agent>,
    scenario: &BuildingScenario,
    geometry: &Geometry<'_>,
) -> Result<(), SimulationError> {
    if !agents.is_empty() {
        return Err(SimulationError::InvalidScenario(
            "initial spawning requires an empty agent vector".into(),
        ));
    }

    let mut spawned: Vec<Agent> = Vec::new();
    let mut random_state = scenario.seed;
    let radius = scenario.agent_radius;

    for zone in &scenario.spawn_zones {
        // Keep each agent's whole disc within its spawn rectangle.
        let min_x = zone.x + radius;
        let min_y = zone.y + radius;
        let available_width = zone.width - 2.0 * radius;
        let available_height = zone.height - 2.0 * radius;

        for occupant in 0..zone.count {
            let mut accepted = None;
            for _ in 0..1000 {
                super::control::checkpoint()?;
                let position = Point {
                    x: min_x + random_unit(&mut random_state) * available_width,
                    y: min_y + random_unit(&mut random_state) * available_height,
                };
                if !geometry.can_stand_at(position) {
                    continue;
                }
                if spawned
                    .iter()
                    .any(|agent| math::circles_overlap(position, radius, agent.position, radius))
                {
                    continue;
                }

                accepted = Some(position);
                break;
            }

            let position = accepted.ok_or_else(|| {
                SimulationError::InvalidScenario(format!(
                    "could not place occupant {} of {} in spawn zone '{}' after 1000 attempts; enlarge the clear area, move obstacles, or reduce its population",
                    occupant + 1, zone.count, zone.id,
                ))
            })?;
            spawned.push(Agent::new(spawned.len() as u32, position));
        }
    }

    *agents = spawned;
    Ok(())
}

// SplitMix64: repeatable simulation sampling, not security randomness.
fn random_unit(state: &mut u64) -> f64 {
    *state = state.wrapping_add(0x9e3779b97f4a7c15);
    let mut value = *state;
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d049bb133111eb);
    value ^= value >> 31;
    (value >> 11) as f64 / 9_007_199_254_740_992.0
}
