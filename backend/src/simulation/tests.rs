use super::{geometry::Geometry, math, navigation::Navigation, simulate};
use crate::models::{
    BuildingScenario, Opening, Point, SimulationResult, SimulationStatus, SpawnZone, Wall,
};
use std::collections::BTreeMap;

fn room() -> BuildingScenario {
    BuildingScenario {
        width: 10.0,
        height: 10.0,
        walls: [
            ("north", 0.0, 0.0, 10.0, 0.0),
            ("east", 10.0, 0.0, 10.0, 10.0),
            ("south", 10.0, 10.0, 0.0, 10.0),
            ("west", 0.0, 10.0, 0.0, 0.0),
        ]
        .into_iter()
        .map(|(id, x, y, end_x, end_y)| Wall {
            name: None,
            id: id.into(),
            start: Point { x, y },
            end: Point { x: end_x, y: end_y },
            thickness: 0.2,
        })
        .collect(),
        doors: vec![],
        exits: vec![Opening {
            name: None,
            id: "north_exit".into(),
            wall_id: "north".into(),
            offset: 3.0,
            width: 4.0,
        }],
        // Diameter-sized zones pin the audited positions exactly, using the
        // production spawner without overriding IDs, seeds, or initial frames.
        spawn_zones: vec![
            pinned_zone("left", 1.0, 1.0),
            pinned_zone("right", 9.0, 1.0),
        ],
        blocked_exit_ids: vec![],
        awareness: Default::default(),
        opening_events: vec![],
        obstructions: vec![],
        stair_areas: vec![],
        agent_radius: 0.2,
        time_step_seconds: 0.1,
        seed: 42,
        max_steps: 1000,
    }
}

#[test]
fn live_frames_arrive_during_physics_and_preserve_the_recording() {
    let scenario = room();
    let expected = simulate(&scenario).unwrap();
    let mut streamed = Vec::new();
    let result = super::simulate_live(&scenario, &mut |frame| {
        streamed.push(frame.clone());
        true
    })
    .unwrap();
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
    assert_eq!(
        serde_json::to_value(streamed).unwrap(),
        serde_json::to_value(result.frames).unwrap()
    );
}

#[test]
fn an_unknown_exit_state_does_not_change_distant_crowd_guidance() {
    let mut open = room();
    open.spawn_zones = vec![
        pinned_zone("left", 4.6, 4.0),
        pinned_zone("right", 5.4, 4.0),
    ];
    open.awareness.sight_range_metres = 0.0;
    open.awareness.communication_range_metres = 0.0;
    open.max_steps = 20;
    let mut closed = open.clone();
    closed.blocked_exit_ids = vec!["north_exit".into()];
    let open_result = simulate(&open).unwrap();
    let closed_result = simulate(&closed).unwrap();
    assert_eq!(open_result.frames.len(), closed_result.frames.len());
    for (open_frame, closed_frame) in open_result.frames.iter().zip(&closed_result.frames) {
        assert!(
            open_frame.agents.iter().all(|agent| agent.y > 0.8),
            "stay outside local wall avoidance range"
        );
        assert_eq!(
            serde_json::to_value(&open_frame.agents).unwrap(),
            serde_json::to_value(&closed_frame.agents).unwrap(),
            "unknown closure changed steering at step {}",
            open_frame.step
        );
    }
}

#[test]
fn a_wall_covering_the_example_exit_is_not_known_at_spawn() {
    let mut open: BuildingScenario =
        serde_json::from_str(include_str!("../../../shared/examples/building.json")).unwrap();
    open.awareness.sight_range_metres = 0.0;
    open.awareness.communication_range_metres = 0.0;
    open.max_steps = 2;
    let mut covered = open.clone();
    covered.walls.push(Wall {
        id: "cover".into(),
        name: None,
        start: Point { x: 2.0, y: 9.0 },
        end: Point { x: 2.0, y: 12.0 },
        thickness: 0.2,
    });
    let expected = simulate(&open).unwrap();
    let actual = simulate(&covered).unwrap();
    for (a, b) in expected.frames.iter().zip(&actual.frames) {
        assert_eq!(
            serde_json::to_value(&a.agents).unwrap(),
            serde_json::to_value(&b.agents).unwrap(),
            "an unseen wall covering the exit changed initial movement at step {}",
            a.step
        );
    }
}

#[test]
fn mid_run_exit_closure_is_discovered_and_agents_use_another_exit() {
    let mut scenario = room();
    scenario.spawn_zones = vec![pinned_zone("person", 5.0, 5.0)];
    scenario.exits.push(Opening {
        id: "south_exit".into(),
        name: None,
        wall_id: "south".into(),
        offset: 3.0,
        width: 4.0,
    });
    scenario.opening_events = vec![crate::models::OpeningStateChange {
        step: 10,
        opening_id: "north_exit".into(),
        blocked: true,
    }];
    let result = simulate(&scenario).unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(
        result.analytics.as_ref().unwrap().agents[0]
            .exit_id
            .as_deref(),
        Some("south_exit")
    );
    // Closure discovery must override commitment before its three-second hold
    // expires, even though turning toward the south reverses the route.
    let at_closure = &result
        .frames
        .iter()
        .find(|frame| frame.step == 10)
        .unwrap()
        .agents[0];
    let reacted = &result
        .frames
        .iter()
        .find(|frame| frame.step == 30)
        .unwrap()
        .agents[0];
    assert!(reacted.y > at_closure.y + 0.2);
    assert!(result.frames.iter().filter(|f| f.step >= 10).all(|f| {
        f.blocked_opening_ids
            .as_ref()
            .unwrap()
            .contains(&"north_exit".into())
    }));
    assert!(
        result.frames.iter().filter(|f| f.step < 10).all(|f| f
            .blocked_opening_ids
            .as_ref()
            .unwrap()
            .is_empty())
    );
    for pair in result.frames.windows(2) {
        let mask = pair[0]
            .blocked_opening_ids
            .as_ref()
            .unwrap()
            .iter()
            .cloned()
            .collect();
        let geometry = Geometry::with_blocked_openings(&scenario, &[], mask);
        for agent in &pair[0].agents {
            if let Some(next) = pair[1].agents.iter().find(|a| a.id == agent.id) {
                assert!(geometry.can_move(
                    Point {
                        x: agent.x,
                        y: agent.y
                    },
                    Point {
                        x: next.x,
                        y: next.y
                    }
                ));
            }
        }
    }
}

#[test]
fn a_future_reopening_keeps_a_run_alive_until_agents_can_discover_it() {
    let mut scenario = room();
    scenario.spawn_zones = vec![pinned_zone("person", 5.0, 1.0)];
    scenario.blocked_exit_ids = vec!["north_exit".into()];
    scenario.opening_events = vec![crate::models::OpeningStateChange {
        step: 20,
        opening_id: "north_exit".into(),
        blocked: false,
    }];
    let result = simulate(&scenario).unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert!(
        result.analytics.as_ref().unwrap().agents[0]
            .evacuation_step
            .unwrap()
            > 20
    );
}

#[test]
fn an_unseen_closed_door_is_never_traversed() {
    let mut scenario = room();
    scenario.walls.push(Wall {
        id: "partition".into(),
        name: None,
        start: Point { x: 0.0, y: 5.0 },
        end: Point { x: 10.0, y: 5.0 },
        thickness: 0.2,
    });
    scenario.doors.push(Opening {
        id: "door".into(),
        name: None,
        wall_id: "partition".into(),
        offset: 4.0,
        width: 2.0,
    });
    scenario.spawn_zones = vec![pinned_zone("person", 5.0, 8.0)];
    scenario.awareness.sight_range_metres = 0.0;
    scenario.opening_events = vec![crate::models::OpeningStateChange {
        step: 2,
        opening_id: "door".into(),
        blocked: true,
    }];
    scenario.max_steps = 100;
    let result = simulate(&scenario).unwrap();
    assert_eq!(result.metrics.evacuated, 0);
    for frame in &result.frames {
        assert!(frame.agents[0].y >= 5.0 + scenario.agent_radius + 0.1 - 1e-8);
    }
}

#[test]
fn discovering_a_closed_door_reroutes_through_an_alternative_door() {
    let mut scenario = room();
    scenario.walls.push(Wall {
        id: "partition".into(),
        name: None,
        start: Point { x: 0.0, y: 5.0 },
        end: Point { x: 10.0, y: 5.0 },
        thickness: 0.2,
    });
    scenario.doors = vec![
        Opening {
            id: "closed".into(),
            name: None,
            wall_id: "partition".into(),
            offset: 4.0,
            width: 2.0,
        },
        Opening {
            id: "alternative".into(),
            name: None,
            wall_id: "partition".into(),
            offset: 7.5,
            width: 2.0,
        },
    ];
    scenario.spawn_zones = vec![pinned_zone("person", 5.0, 8.0)];
    scenario.awareness.sight_range_metres = 1.0;
    scenario.awareness.communication_range_metres = 0.0;
    scenario.opening_events = vec![crate::models::OpeningStateChange {
        step: 0,
        opening_id: "closed".into(),
        blocked: true,
    }];
    let result = simulate(&scenario).unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    // The unobserved closure does not change the initial plan toward x=5.
    assert!((result.frames[1].agents[0].x - 5.0).abs() < 1e-6);
    assert!(result.frames[1].agents[0].y < 8.0);
    assert!(result.frames.iter().any(|f| {
        f.agents
            .iter()
            .any(|a| a.x > 7.5 && (a.y - 5.0).abs() < 0.2)
    }));
}

#[test]
fn disconnecting_a_live_view_stops_the_simulation() {
    let mut steps = Vec::new();
    let result = super::simulate_live(&room(), &mut |frame| {
        steps.push(frame.step);
        frame.step == 0
    });
    assert!(matches!(result, Err(super::SimulationError::Cancelled)));
    assert_eq!(steps, vec![0, 1]);
}

fn pinned_zone(id: &str, center_x: f64, center_y: f64) -> SpawnZone {
    SpawnZone {
        name: None,
        id: id.into(),
        x: center_x - 0.2,
        y: center_y - 0.2,
        width: 0.4,
        height: 0.4,
        count: 1,
    }
}

fn initial_positions(result: &SimulationResult) -> BTreeMap<u32, (f64, f64)> {
    assert_eq!(result.frames[0].step, 0);
    result.frames[0]
        .agents
        .iter()
        .map(|agent| (agent.id, (agent.x, agent.y)))
        .collect()
}

/// Independently check minimum relative separation throughout each tick, not
/// just at frame endpoints. These small runs retain every simulation tick.
fn assert_collision_free(scenario: &BuildingScenario, result: &SimulationResult) {
    result.validate().unwrap();
    let geometry = Geometry::new(scenario);
    for frame in &result.frames {
        for (index, agent) in frame.agents.iter().enumerate() {
            assert!(geometry.can_stand_at(Point {
                x: agent.x,
                y: agent.y
            }));
            for other in frame.agents.iter().skip(index + 1) {
                assert!(
                    (agent.x - other.x).hypot(agent.y - other.y) + 1e-9
                        >= 2.0 * scenario.agent_radius
                );
            }
        }
    }
    for frames in result.frames.windows(2) {
        assert_eq!(frames[1].step, frames[0].step + 1);
        // Actual final arrival segments are audited inside the engine.
        let paths: Vec<_> = frames[0]
            .agents
            .iter()
            .filter_map(|start| {
                let end = frames[1].agents.iter().find(|end| start.id == end.id)?;
                Some((
                    Point {
                        x: start.x,
                        y: start.y,
                    },
                    Point { x: end.x, y: end.y },
                ))
            })
            .collect();
        for (i, (start, end)) in paths.iter().enumerate() {
            assert!(geometry.can_move(*start, *end));
            assert!(
                (start.x - end.x).hypot(start.y - end.y) <= 1.3 * scenario.time_step_seconds + 1e-9
            );
            for (other_start, other_end) in paths.iter().skip(i + 1) {
                let x = start.x - other_start.x;
                let y = start.y - other_start.y;
                let dx = end.x - other_end.x - x;
                let dy = end.y - other_end.y - y;
                let length_squared = dx * dx + dy * dy;
                let t = if length_squared == 0.0 {
                    0.0
                } else {
                    (-(x * dx + y * dy) / length_squared).clamp(0.0, 1.0)
                };
                assert!((x + t * dx).hypot(y + t * dy) + 1e-9 >= 2.0 * scenario.agent_radius);
            }
        }
    }
}

#[test]
fn wide_exit_offers_distinct_body_clear_arrival_positions() {
    let scenario = room();
    let geometry = Geometry::new(&scenario);
    let navigation = Navigation::new(&scenario, &geometry);
    let from_left = Point { x: 1.0, y: 1.0 };
    let from_right = Point { x: 9.0, y: 1.0 };
    let left = navigation.find_route(from_left, &geometry).unwrap();
    let right = navigation.find_route(from_right, &geometry).unwrap();
    let left_target = *left.waypoints.last().unwrap();
    let right_target = *right.waypoints.last().unwrap();
    assert_eq!(left.exit_id, right.exit_id);
    assert!(math::distance_to_point(left_target, right_target) > 3.0);
    for (mut from, route) in [(from_left, left), (from_right, right)] {
        let target = *route.waypoints.last().unwrap();
        for to in route.waypoints {
            assert!(geometry.can_move(from, to));
            from = to;
        }
        assert!(target.x >= 3.0 + scenario.agent_radius);
        assert!(target.x <= 7.0 - scenario.agent_radius);
        assert_eq!(target.y, 0.0);
    }
}

#[test]
fn audited_two_occupant_wide_exit_evacuates_without_recovery_stall() {
    let scenario = room();
    let result = simulate(&scenario).unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(result.metrics.evacuated, 2);
    assert_eq!(result.metrics.remaining, 0);
    assert!(result.metrics.clearance_steps.is_some());
    assert_eq!(
        initial_positions(&result),
        BTreeMap::from([(0, (1.0, 1.0)), (1, (9.0, 1.0))])
    );
    assert!(
        result
            .analytics
            .as_ref()
            .unwrap()
            .agents
            .iter()
            .all(|agent| agent.route_found)
    );
    let mut single = scenario.clone();
    single.spawn_zones.pop();
    let single_steps = simulate(&single).unwrap().metrics.clearance_steps.unwrap();
    // Yielding should add only the ticks needed to clear the body-sized exit
    // region, rather than requiring a two-second stuck-recovery cycle.
    let yield_steps =
        ((2.0 * scenario.agent_radius) / (1.3 * scenario.time_step_seconds)).ceil() as u32;
    let acceleration_steps = (super::motion::WALKING_SPEED
        / (super::motion::ACCELERATION * scenario.time_step_seconds))
        .ceil() as u32;
    assert!(
        result.metrics.clearance_steps.unwrap()
            <= single_steps + yield_steps + acceleration_steps + 2,
        "crowd {:?}, single {single_steps}",
        result.metrics.clearance_steps
    );
    assert_collision_free(&scenario, &result);
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::to_value(simulate(&scenario).unwrap()).unwrap()
    );
}

#[test]
fn inset_exit_keeps_waiting_agents_inside_the_room() {
    let mut scenario = room();
    scenario.width = 14.0;
    scenario.height = 14.0;
    for wall in &mut scenario.walls {
        wall.start.x += 2.0;
        wall.start.y += 2.0;
        wall.end.x += 2.0;
        wall.end.y += 2.0;
    }
    scenario.spawn_zones = vec![SpawnZone {
        name: None,
        id: "crowd".into(),
        x: 3.0,
        y: 4.0,
        width: 8.0,
        height: 6.0,
        count: 24,
    }];
    scenario.max_steps = 600;
    for angle in [0.0_f64, std::f64::consts::FRAC_PI_4, std::f64::consts::PI] {
        let mut rotated = scenario.clone();
        if angle != 0.0 {
            rotated.width = 16.0;
            rotated.height = 16.0;
            for wall in &mut rotated.walls {
                for point in [&mut wall.start, &mut wall.end] {
                    let (x, y) = (point.x - 7.0, point.y - 7.0);
                    point.x = 8.0 + x * angle.cos() - y * angle.sin();
                    point.y = 8.0 + x * angle.sin() + y * angle.cos();
                }
            }
            // An axis-aligned spawn area wholly inside the rotated room.
            rotated.spawn_zones[0].x = 6.0;
            rotated.spawn_zones[0].y = 6.0;
            rotated.spawn_zones[0].width = 4.0;
            rotated.spawn_zones[0].height = 4.0;
        }
        let wall = &rotated.walls[0];
        let (start, end) = (wall.start, wall.end);
        for seed in 0..4 {
            rotated.seed = seed;
            let result = simulate(&rotated).unwrap();
            for frame in &result.frames {
                for agent in &frame.agents {
                    let side = ((end.x - start.x) * (agent.y - start.y)
                        - (end.y - start.y) * (agent.x - start.x))
                        / 10.0;
                    assert!(
                        side >= -1e-9,
                        "angle {angle}, seed {seed}, step {}, agent {} escaped by {} m",
                        frame.step,
                        agent.id,
                        -side
                    );
                }
            }
            assert_eq!(result.metrics.status, SimulationStatus::Completed);
            assert_collision_free(&rotated, &result);
        }
    }
}

#[test]
fn blocked_exit_remains_solid_with_stable_initial_positions() {
    let scenario = room();
    let baseline = simulate(&scenario).unwrap();
    let mut blocked = scenario.clone();
    blocked.blocked_exit_ids.push("north_exit".into());
    let result = simulate(&blocked).unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Incomplete);
    assert_eq!(result.metrics.evacuated, 0);
    assert_eq!(result.metrics.remaining, 2);
    assert_eq!(result.metrics.clearance_steps, None);
    assert_eq!(initial_positions(&baseline), initial_positions(&result));
    let geometry = Geometry::new(&blocked);
    assert!(!geometry.can_move(Point { x: 5.0, y: 1.0 }, Point { x: 5.0, y: 0.0 }));
}

#[test]
fn nominal_openings_require_body_and_rounded_jamb_clearance() {
    let mut scenario = room();
    scenario.spawn_zones = vec![pinned_zone("center", 3.35, 1.0)];
    scenario.exits[0].width = 0.7;
    let result = simulate(&scenario).unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_collision_free(&scenario, &result);
    scenario.exits[0].width = 0.5;
    let result = simulate(&scenario).unwrap();
    assert_eq!(result.metrics.evacuated, 0);
    assert_eq!(result.metrics.clearance_steps, None);
    scenario.exits[0].width = 0.39;
    let result = simulate(&scenario).unwrap();
    assert_eq!(result.metrics.evacuated, 0);
    assert_eq!(result.metrics.clearance_steps, None);
}

#[test]
fn obstruction_detour_respects_solid_walls_and_body_clearance() {
    let mut scenario = room();
    scenario.spawn_zones = vec![pinned_zone("south_spawn", 5.0, 8.0)];
    scenario.obstructions.push(crate::models::Obstruction {
        name: None,
        id: "barrier".into(),
        x: 4.0,
        y: 1.5,
        width: 2.0,
        height: 3.0,
    });
    let result = simulate(&scenario).unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert!(
        result
            .frames
            .iter()
            .flat_map(|frame| &frame.agents)
            .any(|agent| agent.x < 3.8 || agent.x > 6.2)
    );
    assert_collision_free(&scenario, &result);
}

#[test]
fn diagonal_exit_targets_respect_wall_geometry() {
    let mut scenario = room();
    scenario.walls.push(Wall {
        name: None,
        id: "diagonal".into(),
        start: Point { x: 0.0, y: 0.0 },
        end: Point { x: 10.0, y: 10.0 },
        thickness: 0.2,
    });
    scenario.exits[0] = Opening {
        name: None,
        id: "diagonal_exit".into(),
        wall_id: "diagonal".into(),
        offset: 7.0,
        width: 2.0,
    };
    scenario.spawn_zones = vec![pinned_zone("southwest", 2.0, 6.0)];
    let result = simulate(&scenario).unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_collision_free(&scenario, &result);
}

#[test]
fn sample_opening_changes_preserve_spawning_by_id() {
    let scenario: BuildingScenario =
        serde_json::from_str(include_str!("../../../shared/examples/building.json")).unwrap();
    let baseline = simulate(&scenario).unwrap();
    let mut changed = scenario.clone();
    changed.exits[0].width += 0.5;
    let widened = simulate(&changed).unwrap();
    assert_eq!(baseline.metrics.status, SimulationStatus::Completed);
    assert_eq!(widened.metrics.status, SimulationStatus::Completed);
    assert_eq!(initial_positions(&baseline), initial_positions(&widened));
}

#[test]
fn unobstructed_motion_accelerates_and_turns_gradually() {
    use super::motion::{ACCELERATION, Motion, WALKING_SPEED};
    let mut motion = Motion::new();
    let mut position = Point { x: 0.0, y: 0.0 };
    let dt = 0.1;
    for tick in 0..25 {
        let target = if tick < 10 {
            Point { x: 100.0, y: 0.0 }
        } else {
            Point {
                x: position.x,
                y: 100.0,
            }
        };
        let before_velocity = motion.velocity();
        let preferred = motion.preferred_velocity(
            position,
            target,
            dt,
            0.2,
            &[],
            &Geometry::new(&room()).velocity_limits(position, dt),
        );
        let proposed = motion.propose(
            position,
            preferred,
            dt,
            0.2,
            &[],
            Geometry::new(&room()).velocity_limits(position, dt),
        );
        motion.accepted(position, proposed, dt);
        let velocity = motion.velocity();
        assert!(math::distance_to_point(before_velocity, velocity) <= ACCELERATION * dt + 1e-9);
        assert!(velocity.x.hypot(velocity.y) <= WALKING_SPEED + 1e-9);
        position = proposed;
    }
    assert!(motion.velocity().y > 1.0);
}

#[test]
fn head_on_walkers_pass_smoothly_without_crossing_bodies() {
    use super::motion::{Motion, Neighbor};
    let scenario = room();
    let geometry = Geometry::new(&scenario);
    let mut positions = [Point { x: 2.0, y: 5.0 }, Point { x: 8.0, y: 5.0 }];
    let targets = [positions[1], positions[0]];
    let mut controllers = [Motion::new(), Motion::new()];
    let mut stopped_ticks = 0;
    let mut lateral_excursion = 0.0_f64;
    let dt = 0.1;
    for _tick in 0..120 {
        let before = positions;
        let velocities = [controllers[0].velocity(), controllers[1].velocity()];
        let intents: Vec<_> = (0..2)
            .map(|i| {
                let neighbor = Neighbor {
                    position: before[1 - i],
                    velocity: velocities[1 - i],
                    responsibility: 0.5,
                    horizon: 1.5,
                };
                controllers[i].preferred_velocity(
                    before[i],
                    targets[i],
                    dt,
                    0.2,
                    &[neighbor],
                    &geometry.velocity_limits(before[i], dt),
                )
            })
            .collect();
        let mut proposed = before;
        for i in 0..2 {
            let j = 1 - i;
            let neighbor = Neighbor {
                position: before[j],
                velocity: intents[j],
                responsibility: if math::distance_to_point(before[j], targets[j]) > math::EPSILON {
                    0.5
                } else {
                    1.0
                },
                horizon: 1.5,
            };
            proposed[i] = controllers[i].propose(
                before[i],
                intents[i],
                dt,
                0.2,
                &[neighbor],
                geometry.velocity_limits(before[i], dt),
            );
            if math::distance_to_point(proposed[i], targets[i]) < 1e-8 {
                proposed[i] = targets[i];
            }
            assert!(geometry.can_move(before[i], proposed[i]));
        }
        super::motion::resolve_collisions(&before, &mut proposed, &[true; 2], 0.2);
        for i in 0..2 {
            if math::distance_to_point(before[i], targets[i]) > math::EPSILON
                && math::distance_to_point(before[i], proposed[i]) <= math::EPSILON
            {
                stopped_ticks += 1;
            }
            controllers[i].accepted(before[i], proposed[i], dt);
            positions[i] = proposed[i];
            lateral_excursion = lateral_excursion.max((positions[i].y - 5.0).abs());
        }
        // Independent minimum separation during the simultaneous tick.
        let x = before[0].x - before[1].x;
        let y = before[0].y - before[1].y;
        let dx = positions[0].x - positions[1].x - x;
        let dy = positions[0].y - positions[1].y - y;
        let square = dx * dx + dy * dy;
        let t = if square == 0.0 {
            0.0
        } else {
            (-(x * dx + y * dy) / square).clamp(0.0, 1.0)
        };
        assert!((x + t * dx).hypot(y + t * dy) + 1e-9 >= 0.4);
        if (0..2).all(|i| math::distance_to_point(positions[i], targets[i]) <= math::EPSILON) {
            break;
        }
    }
    assert!(
        lateral_excursion > 0.2,
        "walkers should steer around each other"
    );
    assert!(
        stopped_ticks <= 2,
        "unexpected stop-start ticks: {stopped_ticks}"
    );
    for i in 0..2 {
        assert!(
            math::distance_to_point(positions[i], targets[i]) <= math::EPSILON,
            "walker {i} did not reach its target"
        );
    }
}

#[test]
fn smooth_motion_stays_outside_emergency_zones() {
    let mut scenario = room();
    scenario.spawn_zones = vec![pinned_zone("south_spawn", 5.0, 8.0)];
    let emergency = super::Emergency {
        center: Point { x: 5.0, y: 4.0 },
        radius: 1.0,
    };
    let result = super::simulate_with_emergencies(&scenario, &[emergency]).unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    result.validate().unwrap();
    for frames in result.frames.windows(2) {
        for start in &frames[0].agents {
            if let Some(end) = frames[1].agents.iter().find(|end| end.id == start.id) {
                assert!(
                    math::distance_to_segment(
                        emergency.center,
                        Point {
                            x: start.x,
                            y: start.y
                        },
                        Point { x: end.x, y: end.y }
                    ) > emergency.radius + scenario.agent_radius
                );
            }
        }
    }
}

#[test]
fn crowded_open_room_keeps_flowing_across_seeds() {
    for count in [12, 24, 48] {
        for seed in 0..4 {
            let mut scenario = room();
            scenario.spawn_zones = vec![SpawnZone {
                name: None,
                id: "crowd".into(),
                x: 1.0,
                y: 2.0,
                width: 8.0,
                height: 6.0,
                count,
            }];
            scenario.seed = seed;
            scenario.max_steps = 600;
            let result = simulate(&scenario).unwrap();
            assert_eq!(
                result.metrics.status,
                SimulationStatus::Completed,
                "population {count}, seed {seed}: {:?}",
                result.metrics
            );
            assert_collision_free(&scenario, &result);
        }
    }
}

#[test]
fn avoidance_is_active_on_the_first_tick() {
    use super::motion::{Motion, Neighbor};
    let controller = Motion::new();
    let from = Point { x: 4.5, y: 5.0 };
    let neighbor = Neighbor {
        position: Point { x: 5.5, y: 5.0 },
        velocity: Point { x: -1.3, y: 0.0 },
        responsibility: 0.5,
        horizon: 1.5,
    };
    let preferred =
        controller.preferred_velocity(from, Point { x: 9.0, y: 5.0 }, 0.1, 0.2, &[neighbor], &[]);
    assert!(preferred.y > 0.0, "avoid before waiting for a stuck timer");
}

#[test]
fn starting_near_an_exit_still_accelerates_gradually() {
    let mut scenario = room();
    scenario.spawn_zones = vec![pinned_zone("near_exit", 5.0, 0.4)];
    let result = simulate(&scenario).unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    let first = &result.frames[1].agents[0];
    assert!(
        (first.x - 5.0).hypot(first.y - 0.4)
            <= super::motion::ACCELERATION * scenario.time_step_seconds.powi(2) + 1e-9
    );
    assert_collision_free(&scenario, &result);
}

#[test]
fn tangent_roundoff_is_tolerated_but_real_overlap_is_rejected() {
    let left = Point { x: 4.6, y: 0.0 };
    let right = Point { x: 5.0, y: 0.0 };
    assert!(!math::moving_circles_overlap(
        left, left, 0.2, right, right, 0.2
    ));
    assert!(math::moving_circles_overlap(
        left,
        Point { x: 4.60001, y: 0.0 },
        0.2,
        right,
        right,
        0.2,
    ));
}

#[test]
fn final_safety_check_rechecks_neighbors_after_stopping_a_move() {
    let before = [
        Point { x: 0.0, y: 0.0 },
        Point { x: 0.5, y: 0.0 },
        Point { x: 1.0, y: 0.0 },
    ];
    let mut proposed = [
        Point { x: 0.2, y: 0.0 },
        Point { x: 0.7, y: 0.0 },
        before[2],
    ];
    super::motion::resolve_collisions(&before, &mut proposed, &[true; 3], 0.2);
    for i in 0..3 {
        for j in i + 1..3 {
            assert!(!math::moving_circles_overlap(
                before[i],
                proposed[i],
                0.2,
                before[j],
                proposed[j],
                0.2
            ));
        }
    }
}

#[test]
fn unseen_hazards_and_obstructions_do_not_change_distant_movement() {
    let mut scenario = room();
    scenario.spawn_zones = vec![pinned_zone("person", 5.0, 8.0)];
    scenario.awareness.sight_range_metres = 0.5;
    scenario.awareness.communication_range_metres = 0.0;
    scenario.max_steps = 10;
    let baseline = simulate(&scenario).unwrap();
    let emergency = super::Emergency {
        center: Point { x: 5.0, y: 4.0 },
        radius: 0.6,
    };
    let hazard_result = super::simulate_with_emergencies(&scenario, &[emergency]).unwrap();
    scenario.obstructions.push(crate::models::Obstruction {
        id: "hidden_crate".into(),
        name: None,
        x: 4.5,
        y: 3.5,
        width: 1.0,
        height: 1.0,
    });
    let obstruction_result = simulate(&scenario).unwrap();
    for result in [&hazard_result, &obstruction_result] {
        assert_eq!(result.frames.len(), baseline.frames.len());
        for (actual, expected) in result.frames.iter().zip(&baseline.frames) {
            assert_eq!(
                serde_json::to_value(&actual.agents).unwrap(),
                serde_json::to_value(&expected.agents).unwrap(),
                "a distant, unwitnessed blocker changed motion at step {}",
                actual.step
            );
        }
    }
}

#[test]
fn approaching_an_unknown_hazard_triggers_a_safe_detour_after_discovery() {
    let mut scenario = room();
    scenario.spawn_zones = vec![pinned_zone("person", 5.0, 8.0)];
    scenario.awareness.sight_range_metres = 1.0;
    scenario.awareness.communication_range_metres = 0.0;
    let emergency = super::Emergency {
        center: Point { x: 5.0, y: 4.0 },
        radius: 1.0,
    };
    let result = super::simulate_with_emergencies(&scenario, &[emergency]).unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_collision_free(&scenario, &result);
    let first_turn = result
        .frames
        .iter()
        .position(|frame| {
            frame
                .agents
                .first()
                .is_some_and(|agent| (agent.x - 5.0).abs() > 1e-8)
        })
        .expect("a detour must steer around the hazard");
    let before_turn = &result.frames[first_turn - 1].agents[0];
    assert!(
        before_turn.y <= 6.0 + 1e-8,
        "the person must approach within sight before choosing a detour"
    );
    for pair in result.frames.windows(2) {
        let start = &pair[0].agents[0];
        let end = pair[1]
            .agents
            .first()
            .map_or(Point { x: 5.0, y: 0.0 }, |agent| Point {
                x: agent.x,
                y: agent.y,
            });
        assert!(
            math::distance_to_segment(
                emergency.center,
                Point {
                    x: start.x,
                    y: start.y
                },
                end
            ) > emergency.radius + scenario.agent_radius
        );
    }
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::to_value(super::simulate_with_emergencies(&scenario, &[emergency]).unwrap())
            .unwrap()
    );
}

#[test]
fn approaching_an_unknown_obstruction_triggers_a_safe_detour_after_discovery() {
    let mut scenario = room();
    scenario.spawn_zones = vec![pinned_zone("person", 5.0, 8.0)];
    scenario.awareness.sight_range_metres = 0.75;
    scenario.awareness.communication_range_metres = 0.0;
    scenario.obstructions.push(crate::models::Obstruction {
        id: "debris".into(),
        name: None,
        x: 4.0,
        y: 3.5,
        width: 2.0,
        height: 1.5,
    });
    let result = simulate(&scenario).unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_collision_free(&scenario, &result);
    let first_turn = result
        .frames
        .iter()
        .position(|frame| {
            frame
                .agents
                .first()
                .is_some_and(|agent| (agent.x - 5.0).abs() > 1e-8)
        })
        .expect("a detour must go around debris");
    assert!(
        result.frames[first_turn - 1].agents[0].y <= 5.75 + 1e-8,
        "the person should learn about the obstruction only once it is visible"
    );
}

#[test]
fn agents_approach_an_unknown_walled_off_exit_before_discovering_another_route() {
    let mut scenario = room();
    scenario.spawn_zones = vec![pinned_zone("person", 5.0, 4.0)];
    scenario.awareness.sight_range_metres = 0.75;
    scenario.awareness.communication_range_metres = 0.0;
    scenario.exits.push(Opening {
        id: "south_exit".into(),
        name: None,
        wall_id: "south".into(),
        offset: 3.0,
        width: 4.0,
    });
    scenario.walls.extend([
        Wall {
            id: "pocket_front".into(),
            name: None,
            start: Point { x: 3.0, y: 2.0 },
            end: Point { x: 7.0, y: 2.0 },
            thickness: 0.2,
        },
        Wall {
            id: "pocket_left".into(),
            name: None,
            start: Point { x: 3.0, y: 0.0 },
            end: Point { x: 3.0, y: 2.0 },
            thickness: 0.2,
        },
        Wall {
            id: "pocket_right".into(),
            name: None,
            start: Point { x: 7.0, y: 0.0 },
            end: Point { x: 7.0, y: 2.0 },
            thickness: 0.2,
        },
    ]);
    let result = simulate(&scenario).unwrap();
    assert!(
        result.frames[1].agents[0].y < 4.0,
        "the initial plan must approach the nearer north exit, not use unseen enclosure walls"
    );
    assert!(
        result
            .frames
            .iter()
            .any(|frame| frame.agents.iter().any(|agent| agent.y < 3.0)),
        "the person should approach and investigate the barrier"
    );
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(
        result.analytics.as_ref().unwrap().agents[0]
            .exit_id
            .as_deref(),
        Some("south_exit")
    );
    assert_collision_free(&scenario, &result);
}

fn two_exit_room() -> BuildingScenario {
    let mut scenario = room();
    scenario.exits.push(Opening {
        id: "east_exit".into(),
        name: None,
        wall_id: "east".into(),
        offset: 3.0,
        width: 4.0,
    });
    scenario
}

#[test]
fn crowd_search_uses_an_alternate_exit_and_recovers_when_the_queue_clears() {
    let scenario = two_exit_room();
    let geometry = Geometry::new(&scenario);
    let navigation = Navigation::new(&scenario, &geometry);
    let from = Point { x: 5.0, y: 3.0 };
    let queue = [Point { x: 5.0, y: 1.0 }, Point { x: 5.0, y: 2.0 }];
    assert_eq!(
        navigation.find_route(from, &geometry).unwrap().exit_id,
        "north_exit"
    );
    let detour = navigation
        .find_route_with_crowd(from, &geometry, &queue, scenario.agent_radius)
        .unwrap();
    assert_eq!(detour.exit_id, "east_exit");
    let mut start = from;
    for end in detour.waypoints {
        assert!(geometry.can_move(start, end));
        start = end;
    }
    assert_eq!(
        navigation
            .find_route_with_crowd(from, &geometry, &[], scenario.agent_radius)
            .unwrap()
            .exit_id,
        "north_exit"
    );
    // Crowds remain a soft cost when there is no alternative.
    let mut single = scenario.clone();
    single.blocked_exit_ids.push("east_exit".into());
    let geometry = Geometry::new(&single);
    assert_eq!(
        Navigation::new(&single, &geometry)
            .find_route_with_crowd(from, &geometry, &queue, single.agent_radius)
            .unwrap()
            .exit_id,
        "north_exit"
    );
}

#[test]
fn a_clearing_queue_does_not_divert_followers_to_a_distant_exit() {
    let mut scenario = two_exit_room();
    scenario.spawn_zones = vec![
        pinned_zone("observer", 5.0, 3.0),
        pinned_zone("queue_a", 5.0, 1.0),
        pinned_zone("queue_b", 5.0, 2.0),
    ];
    scenario.awareness.communication_range_metres = 0.0;
    let result = simulate(&scenario).unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    let observer = result.frames[0].agents[0].id;
    let stat = result
        .analytics
        .as_ref()
        .unwrap()
        .agents
        .iter()
        .find(|stat| stat.id == observer)
        .unwrap();
    assert_eq!(stat.exit_id.as_deref(), Some("north_exit"));
    assert!(
        stat.distance_metres < 4.0,
        "follow the clearing queue instead of walking to the east exit"
    );
    assert_collision_free(&scenario, &result);
}

#[test]
fn crowd_penalties_are_additive_and_small_savings_do_not_switch_routes() {
    use super::navigation::{crowd_cost, materially_better};
    let from = Point { x: 1.0, y: 2.0 };
    let middle = Point { x: 5.0, y: 2.0 };
    let to = Point { x: 9.0, y: 2.0 };
    let occupants = [middle];
    let full = crowd_cost(from, to, &occupants, 0.2);
    let split = crowd_cost(from, middle, &occupants, 0.2) + crowd_cost(middle, to, &occupants, 0.2);
    assert!((full - split).abs() < 1e-9);
    assert!(full > 0.0);
    assert!(!materially_better(9.0, 10.0, 0.2));
    assert!(materially_better(7.0, 10.0, 0.2));
}

#[test]
fn congestion_can_choose_another_door_to_the_same_exit() {
    let mut scenario = room();
    scenario.walls.push(Wall {
        id: "partition".into(),
        name: None,
        start: Point { x: 0.0, y: 5.0 },
        end: Point { x: 10.0, y: 5.0 },
        thickness: 0.2,
    });
    for (id, offset) in [("direct", 4.0), ("detour", 7.5)] {
        scenario.doors.push(Opening {
            id: id.into(),
            name: None,
            wall_id: "partition".into(),
            offset,
            width: 2.0,
        });
    }
    let geometry = Geometry::new(&scenario);
    let navigation = Navigation::new(&scenario, &geometry);
    let from = Point { x: 5.0, y: 8.0 };
    let queue = [
        Point { x: 5.0, y: 5.0 },
        Point { x: 5.0, y: 6.0 },
        Point { x: 5.0, y: 4.0 },
    ];
    let route = navigation
        .find_route_with_crowd(from, &geometry, &queue, scenario.agent_radius)
        .unwrap();
    assert_eq!(route.exit_id, "north_exit");
    assert!(
        route.waypoints.iter().any(|point| point.x > 7.5),
        "use the alternate door around the queue"
    );
    let mut start = from;
    for end in route.waypoints {
        assert!(geometry.can_move(start, end));
        start = end;
    }
}

// Audit real accepted endpoints, including the last tick before agents vanish
// from animation frames. Exit centres cannot reconstruct those final moves.
pub(super) fn assert_accepted_moves(
    scenario: &BuildingScenario,
    geometry: &Geometry<'_>,
    before: &[Point],
    after: &[Point],
    active: &[bool],
) {
    for i in 0..before.len() {
        if !active[i] {
            continue;
        }
        assert!(geometry.can_move(before[i], after[i]));
        assert!(
            math::distance_to_point(before[i], after[i]) <= 1.3 * scenario.time_step_seconds + 1e-7
        );
        for j in i + 1..before.len() {
            if !active[j] {
                continue;
            }
            let start = Point {
                x: before[i].x - before[j].x,
                y: before[i].y - before[j].y,
            };
            let end = Point {
                x: after[i].x - after[j].x,
                y: after[i].y - after[j].y,
            };
            assert!(
                math::distance_to_segment(Point { x: 0.0, y: 0.0 }, start, end) + 1e-9
                    >= 2.0 * scenario.agent_radius,
                "accepted moves overlap for agents {i} and {j}"
            );
        }
    }
}

#[test]
fn wide_exit_evacuates_people_side_by_side_at_the_same_tick() {
    let mut scenario = room();
    scenario.spawn_zones = vec![
        pinned_zone("left", 4.123, 1.0),
        pinned_zone("right", 6.271, 1.0),
    ];
    let result = simulate(&scenario).unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    let stats = &result.analytics.as_ref().unwrap().agents;
    assert_eq!(stats[0].evacuation_step, stats[1].evacuation_step);
    assert!(stats.iter().all(|agent| agent.distance_metres < 1.01));
    for frame in &result.frames {
        for agent in &frame.agents {
            let original_x = if agent.id == stats[0].id {
                4.123
            } else {
                6.271
            };
            assert!(
                (agent.x - original_x).abs() < 1e-8,
                "an uncongested approach should not converge to the centre"
            );
        }
    }
}

#[test]
fn diagonal_exit_uses_its_width_from_either_side() {
    for side in [-1.0, 1.0] {
        let mut scenario = room();
        scenario.width = 14.0;
        scenario.height = 14.0;
        scenario.walls = vec![Wall {
            id: "diagonal".into(),
            name: None,
            start: Point { x: 2.0, y: 2.0 },
            end: Point { x: 12.0, y: 12.0 },
            thickness: 0.2,
        }];
        scenario.exits = vec![Opening {
            id: "wide".into(),
            name: None,
            wall_id: "diagonal".into(),
            offset: 2.0,
            width: 8.0,
        }];
        let normal = Point {
            x: -side / 2.0_f64.sqrt(),
            y: side / 2.0_f64.sqrt(),
        };
        scenario.spawn_zones = [4.123, 7.271]
            .into_iter()
            .enumerate()
            .map(|(id, along)| {
                let c = 2.0 + along / 2.0_f64.sqrt();
                pinned_zone(&format!("person_{id}"), c + normal.x, c + normal.y)
            })
            .collect();
        let result = simulate(&scenario).unwrap();
        assert_eq!(result.metrics.status, SimulationStatus::Completed);
        let stats = &result.analytics.as_ref().unwrap().agents;
        assert_eq!(stats[0].evacuation_step, stats[1].evacuation_step);
        assert!(
            stats
                .iter()
                .all(|agent| (agent.distance_metres - 1.0).abs() < 1e-6)
        );
    }
}

#[test]
fn a_wider_exit_increases_parallel_flow() {
    let mut wide = room();
    wide.spawn_zones = vec![
        pinned_zone("a", 4.0, 2.0),
        pinned_zone("b", 5.0, 2.0),
        pinned_zone("c", 6.0, 2.0),
    ];
    let mut narrow = wide.clone();
    narrow.exits[0].offset = 4.6;
    narrow.exits[0].width = 0.8;
    let wide_result = simulate(&wide).unwrap();
    let narrow_result = simulate(&narrow).unwrap();
    assert_eq!(wide_result.metrics.status, SimulationStatus::Completed);
    assert_eq!(narrow_result.metrics.status, SimulationStatus::Completed);
    assert!(
        wide_result.metrics.clearance_steps.unwrap()
            < narrow_result.metrics.clearance_steps.unwrap()
    );
}

#[test]
fn forecasting_a_clearing_exit_keeps_the_direct_route_but_a_stuck_queue_does_not() {
    use super::congestion::CrowdMemory;
    let scenario = two_exit_room();
    let geometry = Geometry::new(&scenario);
    let navigation = Navigation::new(&scenario, &geometry);
    let from = Point { x: 5.0, y: 3.0 };
    let queue = [Point { x: 5.0, y: 0.7 }, Point { x: 5.0, y: 1.7 }];
    let mut moving_memory = CrowdMemory::default();
    let mut stuck_memory = CrowdMemory::default();
    for tick in 0..=20 {
        let remaining = 2.0 - tick as f64 * 0.1;
        let moving: Vec<_> = queue
            .iter()
            .enumerate()
            .map(|(id, p)| {
                (
                    id,
                    Point {
                        x: p.x,
                        y: p.y + remaining,
                    },
                )
            })
            .collect();
        let stuck: Vec<_> = queue.iter().copied().enumerate().collect();
        let flow = moving_memory.observe(&moving, tick, 0.1, &geometry);
        let jam = stuck_memory.observe(&stuck, tick, 0.1, &geometry);
        if tick == 20 {
            assert_eq!(
                navigation
                    .find_route_with_forecast(from, &geometry, &flow, scenario.agent_radius)
                    .unwrap()
                    .exit_id,
                "north_exit"
            );
            assert_eq!(
                navigation
                    .find_route_with_forecast(from, &geometry, &jam, scenario.agent_radius)
                    .unwrap()
                    .exit_id,
                "east_exit"
            );
        }
    }
}

#[test]
fn crowd_forecasts_stop_at_walls_and_only_clear_through_available_exits() {
    let scenario = room();
    let open = Geometry::new(&scenario);
    let from = Point { x: 5.0, y: 1.0 };
    let velocity = Point { x: 0.0, y: -1.0 };
    assert!(open.predict_occupant(from, velocity, 3.0).is_none());
    let mut closed = scenario.clone();
    closed.blocked_exit_ids.push("north_exit".into());
    let closed = Geometry::new(&closed);
    let stopped = closed.predict_occupant(from, velocity, 3.0).unwrap();
    assert!(stopped.y >= 0.3);
    assert!(closed.can_move(from, stopped));
    let from = Point { x: 8.0, y: 5.0 };
    let stopped = open
        .predict_occupant(from, Point { x: 1.0, y: 0.0 }, 3.0)
        .unwrap();
    assert!(stopped.x <= 9.7);
    assert!(open.can_move(from, stopped));
}

#[test]
fn a_thirty_person_two_exit_crowd_clears_without_repeated_route_reversals() {
    for seed in [3, 17, 42] {
        let mut scenario = room();
        scenario.seed = seed;
        scenario.awareness.sight_range_metres = 30.0;
        scenario.exits.push(Opening {
            id: "south_exit".into(),
            name: None,
            wall_id: "south".into(),
            offset: 3.0,
            width: 4.0,
        });
        scenario.spawn_zones = vec![SpawnZone {
            id: "crowd".into(),
            name: None,
            x: 3.5,
            y: 3.0,
            width: 3.0,
            height: 4.0,
            count: 30,
        }];
        let result = simulate(&scenario).unwrap();
        assert_eq!(result.metrics.status, SimulationStatus::Completed);
        assert_collision_free(&scenario, &result);
        for person in &result.frames[0].agents {
            let positions: Vec<_> = result
                .frames
                .iter()
                .filter_map(|frame| frame.agents.iter().find(|agent| agent.id == person.id))
                .collect();
            let mut previous_direction = 0.0_f64;
            let mut reversals = 0;
            // Ignore small local avoidance corrections; count sustained travel
            // of at least 0.4 m in successive one-second windows.
            for window in positions.chunks(10) {
                let travel = window.last().unwrap().y - window[0].y;
                if travel.abs() < 0.4 {
                    continue;
                }
                let direction = travel.signum();
                if previous_direction != 0.0 && previous_direction != direction {
                    reversals += 1;
                }
                previous_direction = direction;
            }
            assert!(
                reversals <= 1,
                "seed {seed}, agent {} reversed {reversals} times",
                person.id
            );
        }
    }
}
