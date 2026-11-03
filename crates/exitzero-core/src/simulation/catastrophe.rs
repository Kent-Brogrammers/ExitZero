use super::{agent::Agent, math};
use crate::models::{BuildingScenario, DisasterKind, Opening, Point, TornadoZone};
use std::collections::BTreeMap;

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
    state.kind == DisasterKind::Fire && areas_close_opening(scenario, opening, &state.areas)
}

pub(super) fn areas_close_opening(
    scenario: &BuildingScenario,
    opening: &Opening,
    areas: &[crate::models::HazardArea],
) -> bool {
    // Only the visible burning core closes a passage. The lighter exposure
    // halo remains dangerous, but does not turn a doorway into solid wall.
    scenario
        .disaster
        .is_some_and(|disaster| disaster.kind == DisasterKind::Fire)
        && opening_span(scenario, opening).is_some_and(|(start, end)| {
            areas
                .iter()
                .any(|area| math::distance_to_segment(area.center, start, end) <= area.radius)
        })
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
    let Some((start, end)) = opening_span(scenario, opening) else {
        return false;
    };
    areas.iter().any(|area| {
        let mut footprint = disaster;
        footprint.center = area.center;
        footprint.radius = area.radius;
        math::distance_to_segment(area.center, start, end)
            <= footprint.exposure_radius() + scenario.agent_radius
    })
}

fn opening_span(scenario: &BuildingScenario, opening: &Opening) -> Option<(Point, Point)> {
    let wall = scenario
        .walls
        .iter()
        .find(|wall| wall.id == opening.wall_id)?;
    Some((
        math::interpolate(wall.start, wall.end, opening.offset / wall.length()),
        math::interpolate(
            wall.start,
            wall.end,
            (opening.offset + opening.width) / wall.length(),
        ),
    ))
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

pub(super) fn shelter_at<'a>(
    scenario: &'a BuildingScenario,
    point: Point,
    admissions: &BTreeMap<String, u32>,
) -> Option<&'a TornadoZone> {
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
    scenario.tornado_zones.iter().find(|zone| {
        admissions.get(&zone.id).copied().unwrap_or(0) < zone.capacity()
            && point.x >= zone.x + r
            && point.x <= zone.x + zone.width - r
            && point.y >= zone.y + r
            && point.y <= zone.y + zone.height - r
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Disaster, DisasterDynamics, DisasterState};
    use serde_json::json;

    fn scenario() -> BuildingScenario {
        serde_json::from_value(json!({
            "width": 10.0, "height": 10.0,
            "walls": [
                {"id":"divider", "start":{"x":5.0,"y":0.0}, "end":{"x":5.0,"y":10.0}, "thickness":0.2},
                {"id":"east", "start":{"x":10.0,"y":0.0}, "end":{"x":10.0,"y":10.0}, "thickness":0.2}
            ],
            "doors": [{"id":"door", "wall_id":"divider", "offset":4.0,"width":2.0}],
            "exits": [{"id":"exit", "wall_id":"east", "offset":4.0,"width":2.0}],
            "spawn_zones": [], "placed_occupants": [{"id":"person", "x":1.0,"y":1.0}],
            "blocked_exit_ids": [], "obstructions": [],
            "agent_radius":0.2,"time_step_seconds":0.1,"max_steps":1,"seed":42
        })).unwrap()
    }

    #[test]
    fn recordings_close_doors_and_exits_only_at_visible_fire_core_contact() {
        for (id, wall_x) in [("door", 5.0), ("exit", 10.0)] {
            // Include a core separated by less than an agent radius: body
            // padding must not turn light-ring contact into a physical closure.
            for (distance, closed) in [
                (1.5, false),
                (1.1, false),
                (1.0001, false),
                (1.0, true),
                (0.9, true),
            ] {
                let mut building = scenario();
                building.disaster = Some(Disaster {
                    kind: DisasterKind::Fire,
                    center: Point {
                        x: wall_x - distance,
                        y: 5.0,
                    },
                    radius: 1.0,
                    dynamics: None,
                });
                let recording = crate::simulation::simulate(&building).unwrap();
                recording.validate().unwrap();
                assert_eq!(
                    recording.frames[0]
                        .blocked_opening_ids
                        .as_ref()
                        .unwrap()
                        .iter()
                        .any(|opening| opening == id),
                    closed,
                    "{id}, core distance {distance}"
                );
                let opening = building
                    .doors
                    .iter()
                    .chain(&building.exits)
                    .find(|opening| opening.id == id)
                    .unwrap();
                assert_eq!(
                    areas_close_opening(
                        &building,
                        opening,
                        &DisasterState::initial(building.disaster.unwrap()).areas
                    ),
                    closed,
                    "known patches use the same core-contact rule"
                );
                assert!(
                    areas_block_opening(
                        &building,
                        opening,
                        &DisasterState::initial(building.disaster.unwrap()).areas
                    ),
                    "exposure still marks the light-ring destination as hazardous"
                );
            }
        }
    }

    #[test]
    fn growing_fire_waits_for_core_contact_before_closing_a_door() {
        let mut building = scenario();
        building.disaster = Some(Disaster {
            kind: DisasterKind::Fire,
            center: Point { x: 3.5, y: 5.0 },
            radius: 1.0,
            dynamics: Some(DisasterDynamics {
                growth_rate: 1.0,
                max_patches: 1,
                max_radius: 2.0,
                ..Default::default()
            }),
        });
        let mut world = crate::simulation::awareness::OpeningStates::new(&building);
        let mut observed_core_contact = false;
        for step in 0..=20 {
            world.apply(step, &[], &[]);
            let radius = world.disaster_state().unwrap().areas[0].radius;
            let closed = world.blocked().contains("door");
            assert_eq!(closed, radius >= 1.5, "closure at core radius {radius}");
            observed_core_contact |= closed;
        }
        assert!(
            observed_core_contact,
            "the growing core eventually reaches the doorway"
        );
    }

    #[test]
    fn angled_opening_uses_its_full_span_and_gas_never_closes_it() {
        let mut building = scenario();
        building.walls[0].start = Point { x: 1.0, y: 1.0 };
        building.walls[0].end = Point { x: 9.0, y: 7.0 };
        // The far endpoint is (5.8, 4.6), despite the wall's angle.
        for (kind, closed) in [
            (DisasterKind::Fire, true),
            (DisasterKind::GasLeak, false),
            (DisasterKind::Tornado, false),
        ] {
            building.disaster = Some(Disaster {
                kind,
                center: Point { x: 5.8, y: 5.1 },
                radius: 0.51,
                dynamics: None,
            });
            let state = DisasterState::initial(building.disaster.unwrap());
            assert_eq!(
                state_blocks_opening(&building, &building.doors[0], &state),
                closed
            );
            assert_eq!(
                areas_close_opening(&building, &building.doors[0], &state.areas),
                closed
            );
        }
        building.disaster.as_mut().unwrap().kind = DisasterKind::Fire;
        building.disaster.as_mut().unwrap().radius = 0.49;
        let state = DisasterState::initial(building.disaster.unwrap());
        assert!(!state_blocks_opening(&building, &building.doors[0], &state));
    }
}
