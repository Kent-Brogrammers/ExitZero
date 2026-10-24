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
            id: id.into(),
            start: Point { x, y },
            end: Point { x: end_x, y: end_y },
            thickness: 0.2,
        })
        .collect(),
        doors: vec![],
        exits: vec![Opening {
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
        obstructions: vec![],
        agent_radius: 0.2,
        time_step_seconds: 0.1,
        seed: 42,
        max_steps: 1000,
    }
}

fn pinned_zone(id: &str, center_x: f64, center_y: f64) -> SpawnZone {
    SpawnZone {
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
    let navigation = Navigation::new(scenario, &geometry);
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
        let paths: Vec<_> = frames[0]
            .agents
            .iter()
            .map(|start| {
                let from = Point {
                    x: start.x,
                    y: start.y,
                };
                let to = if let Some(end) = frames[1].agents.iter().find(|end| start.id == end.id) {
                    Point { x: end.x, y: end.y }
                } else {
                    // Include the final arrival tick, even though evacuated
                    // occupants disappear from the returned frame.
                    let statistics = result
                        .analytics
                        .as_ref()
                        .unwrap()
                        .agents
                        .iter()
                        .find(|agent| agent.id == start.id)
                        .unwrap();
                    assert_eq!(statistics.evacuation_step, Some(frames[1].step));
                    let route = navigation.find_route(from, &geometry).unwrap();
                    assert_eq!(statistics.exit_id.as_deref(), Some(route.exit_id.as_str()));
                    *route.waypoints.last().unwrap()
                };
                (from, to)
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
fn wide_exit_preserves_clear_centre_arrival_for_downstream_consumers() {
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
    assert_eq!(math::distance_to_point(left_target, right_target), 0.0);
    for (from, target) in [(from_left, left_target), (from_right, right_target)] {
        assert!(geometry.can_move(from, target));
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
        id: "diagonal".into(),
        start: Point { x: 0.0, y: 0.0 },
        end: Point { x: 10.0, y: 10.0 },
        thickness: 0.2,
    });
    scenario.exits[0] = Opening {
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
