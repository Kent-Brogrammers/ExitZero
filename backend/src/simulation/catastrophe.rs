use super::{agent::Agent, math};
use crate::models::{BuildingScenario, DisasterKind, Opening, Point};

pub(super) fn blocks_opening(scenario: &BuildingScenario, opening: &Opening) -> bool {
    scenario.disaster.is_some_and(|d| {
        state_blocks_opening(scenario, opening, &crate::models::DisasterState::initial(d))
    })
}

pub(super) fn state_blocks_opening(
    scenario: &BuildingScenario,
    opening: &Opening,
    state: &crate::models::DisasterState,
) -> bool {
    areas_block_opening(scenario, opening, &state.areas)
}

pub(super) fn areas_block_opening(
    scenario: &BuildingScenario,
    opening: &Opening,
    areas: &[crate::models::HazardArea],
) -> bool {
    let Some(disaster) = scenario.disaster else {
        return false;
    };
    if disaster.kind == DisasterKind::Tornado {
        return false;
    }
    let Some(wall) = scenario
        .walls
        .iter()
        .find(|wall| wall.id == opening.wall_id)
    else {
        return false;
    };
    let start = math::interpolate(wall.start, wall.end, opening.offset / wall.length());
    let end = math::interpolate(
        wall.start,
        wall.end,
        (opening.offset + opening.width) / wall.length(),
    );
    areas.iter().any(|area| {
        let mut footprint = disaster;
        footprint.center = area.center;
        footprint.radius = area.radius;
        math::distance_to_segment(area.center, start, end)
            <= footprint.exposure_radius() + scenario.agent_radius
    })
}

#[cfg(test)]
pub(super) fn expose(agent: &mut Agent, from: Point, to: Point, scenario: &BuildingScenario) {
    let state = scenario.disaster.map(crate::models::DisasterState::initial);
    expose_between(agent, from, to, scenario, state.as_ref(), state.as_ref());
}

/// Integrate relative motion of people and hazards. Overlapping patches use
/// the strongest exposure, rather than multiplying injury by patch count.
pub(super) fn expose_between(
    agent: &mut Agent,
    from: Point,
    to: Point,
    scenario: &BuildingScenario,
    previous: Option<&crate::models::DisasterState>,
    current: Option<&crate::models::DisasterState>,
) {
    let (Some(disaster), Some(current)) = (scenario.disaster, current) else {
        return;
    };
    let mut exposure = 0.0;
    let mut dose = 0.0;
    for i in 0..16 {
        let fraction = (f64::from(i) + 0.5) / 16.0;
        let position = math::interpolate(from, to, fraction);
        let mut strongest = 0.0_f64;
        for area in &current.areas {
            let old = previous
                .and_then(|state| {
                    state
                        .areas
                        .get(area.id as usize)
                        .filter(|old| old.id == area.id)
                        .or_else(|| state.areas.iter().find(|old| old.id == area.id))
                })
                .unwrap_or(area);
            let center = math::interpolate(old.center, area.center, fraction);
            let mut footprint = disaster;
            footprint.radius = old.radius + (area.radius - old.radius) * fraction;
            let distance = math::distance_to_point(position, center);
            let radius = footprint.exposure_radius() + scenario.agent_radius;
            if distance < radius {
                strongest = strongest.max((1.0 - distance / radius).max(0.1));
                agent.knows_disaster = true;
                agent.known_hazards.insert(area.id, *area);
            }
        }
        if strongest > 0.0 {
            exposure += scenario.time_step_seconds / 16.0;
            dose += strongest * disaster.injury_rate() * scenario.time_step_seconds / 16.0;
        }
    }
    agent.exposure_seconds += exposure;
    agent.injury = (agent.injury + dose).min(1.0);
}

pub(super) fn shelter_at(scenario: &BuildingScenario, point: Point) -> Option<&str> {
    if scenario
        .disaster
        .is_none_or(|d| d.kind != DisasterKind::Tornado)
    {
        return None;
    }
    if scenario.disaster.is_some_and(|d| {
        math::distance_to_point(point, d.center) < d.exposure_radius() + scenario.agent_radius
    }) {
        return None;
    }
    let r = scenario.agent_radius;
    scenario
        .tornado_zones
        .iter()
        .find(|zone| {
            point.x >= zone.x + r
                && point.x <= zone.x + zone.width - r
                && point.y >= zone.y + r
                && point.y <= zone.y + zone.height - r
        })
        .map(|zone| zone.id.as_str())
}
