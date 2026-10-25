//! Fictional Halloween vertical slice. Existing navigation supplies every route;
//! existing swept geometry and crowd collision resolution accept every movement.
use super::{
    SimulationError,
    agent::{self, Agent},
    awareness::OpeningStates,
    congestion::CrowdForecast,
    control,
    geometry::Geometry,
    math, motion,
    navigation::{Navigation, Route},
    record_traffic,
};
use crate::models::{
    AgentPosition, AnimationFrame, BuildingScenario, CaughtAgent, Point, PursuitFrame,
    SimulationMetrics, SimulationResult, SimulationStatus,
};
use std::collections::BTreeMap;

fn advance(
    position: Point,
    route: &mut Option<Route>,
    budget: f64,
    geometry: &Geometry<'_>,
) -> Point {
    let Some(route) = route else {
        return position;
    };
    while route
        .waypoints
        .first()
        .is_some_and(|p| math::distance_to_point(position, *p) < 1e-8)
    {
        route.waypoints.remove(0);
    }
    let Some(&target) = route.waypoints.first() else {
        return position;
    };
    let next = math::move_toward(position, target, budget);
    if geometry.can_move(position, next) {
        next
    } else {
        position
    }
}

fn contact(
    a: Point,
    b: Point,
    hunter_before: Point,
    hunter_after: Point,
    radius: f64,
    geometry: &Geometry<'_>,
) -> bool {
    let relative = Point {
        x: a.x - hunter_before.x,
        y: a.y - hunter_before.y,
    };
    let velocity = Point {
        x: b.x - a.x - hunter_after.x + hunter_before.x,
        y: b.y - a.y - hunter_after.y + hunter_before.y,
    };
    let squared = velocity.x * velocity.x + velocity.y * velocity.y;
    let t = if squared > 0.0 {
        (-(relative.x * velocity.x + relative.y * velocity.y) / squared).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let survivor = math::interpolate(a, b, t);
    let stalker = math::interpolate(hunter_before, hunter_after, t);
    math::distance_to_point(survivor, stalker) <= radius && geometry.can_move(stalker, survivor) // Never tag through a wall or cabinet.
}

fn snapshot(
    step: u32,
    people: &[Agent],
    gone: &[bool],
    stalker: Point,
    escaped: u32,
    caught: &[CaughtAgent],
    world: &OpeningStates,
) -> AnimationFrame {
    AnimationFrame {
        step,
        agents: people
            .iter()
            .zip(gone)
            .filter(|(_, gone)| !**gone)
            .map(|(a, _)| AgentPosition {
                id: a.id,
                x: a.position.x,
                y: a.position.y,
                injury: None,
            })
            .collect(),
        pursuit: Some(PursuitFrame {
            stalker,
            escaped,
            caught: caught.to_vec(),
        }),
        blocked_opening_ids: Some(world.blocked().into_iter().collect()),
        window_states: None,
        sheltered: None,
        disaster_state: None,
    }
}

pub(super) fn run(
    scenario: &BuildingScenario,
    mut emit: Option<&mut dyn FnMut(&AnimationFrame) -> bool>,
) -> Result<SimulationResult, SimulationError> {
    control::checkpoint()?;
    let config = scenario.pursuit.as_ref().unwrap();
    let mut world = OpeningStates::new(scenario);
    world.apply(0, &[], &[]);
    let mut geometry = Geometry::with_blocked_openings(scenario, &[], world.blocked());
    let mut navigation = Navigation::new(scenario, &geometry);
    let mut people = Vec::new();
    agent::spawn_agents(&mut people, scenario, &geometry)?;
    let mut stalker = config.stalker_start;
    if !geometry.can_stand_at(stalker)
        || people
            .iter()
            .any(|a| math::distance_to_point(a.position, stalker) <= config.capture_radius)
    {
        return Err(SimulationError::InvalidScenario(
            "Stalker start must be clear of walls, furniture and survivor spawn positions".into(),
        ));
    }
    let total = people.len() as u32;
    let mut gone = vec![false; people.len()];
    let mut routes: Vec<Option<Route>> = people.iter().map(|_| None).collect();
    let mut hunter_route = None;
    let mut controllers: Vec<_> = people.iter().map(|_| motion::Motion::new()).collect();
    let mut caught = Vec::new();
    let mut escaped = 0;
    let mut frames = Vec::new();
    let mut traffic = BTreeMap::new();
    let replan_stride = (0.5 / scenario.time_step_seconds).ceil().max(1.0) as u32;
    let frame_stride = (u64::from(total) * (u64::from(scenario.max_steps) + 1))
        .div_ceil(200_000)
        .max(1) as u32;
    let mut step = 0;
    loop {
        control::checkpoint()?;
        control::step(step, scenario.max_steps);
        let changed = if scenario.opening_events.is_empty() {
            false
        } else {
            // Reuse ordinary closing-door clearance for every live body,
            // including the stalker, without adding it to survivor accounting.
            let mut bodies: Vec<_> = people
                .iter()
                .map(|a| Agent::new(a.id, a.position))
                .collect();
            bodies.push(Agent::new(total, stalker));
            let mut inactive = gone.clone();
            inactive.push(false);
            world.apply(step, &bodies, &inactive)
        };
        if changed {
            geometry = Geometry::with_blocked_openings(scenario, &[], world.blocked());
            navigation = Navigation::new(scenario, &geometry);
        }
        let frame = snapshot(step, &people, &gone, stalker, escaped, &caught, &world);
        if let Some(callback) = &mut emit
            && !callback(&frame)
        {
            return Err(SimulationError::Cancelled);
        }
        let finished = gone.iter().all(|&g| g) || step == scenario.max_steps;
        if step % frame_stride == 0 || finished {
            frames.push(frame);
        }
        record_traffic(scenario, &people, &gone, &mut traffic);
        if finished {
            break;
        }
        if changed || step % replan_stride == 0 {
            for (i, person) in people.iter().enumerate().filter(|(i, _)| !gone[*i]) {
                control::checkpoint()?;
                let forecast = if math::distance_to_point(person.position, stalker)
                    <= scenario.awareness.sight_range_metres
                    && geometry.has_line_of_sight(person.position, stalker)
                {
                    CrowdForecast::for_pursuit(&geometry, stalker, config.avoidance_radius)
                } else {
                    CrowdForecast::for_geometry(&geometry)
                };
                routes[i] = navigation.find_route_with_forecast(
                    person.position,
                    &geometry,
                    &forecast,
                    scenario.agent_radius,
                );
            }
            // Try nearest living survivors in stable order. Unreachable targets
            // cannot make the stalker ignore a reachable survivor indefinitely.
            let mut targets: Vec<_> = people
                .iter()
                .enumerate()
                .filter(|(i, _)| !gone[*i])
                .collect();
            targets.sort_by(|(i, a), (j, b)| {
                math::distance_to_point(stalker, a.position)
                    .total_cmp(&math::distance_to_point(stalker, b.position))
                    .then(i.cmp(j))
            });
            hunter_route = targets.into_iter().find_map(|(_, person)| {
                Navigation::to_point(
                    scenario,
                    &geometry,
                    "pursuit-target".into(),
                    person.position,
                )
                .find_route(stalker, &geometry)
            });
        }
        control::checkpoint()?;
        let before: Vec<_> = people.iter().map(|a| a.position).collect();
        // Use the ordinary reciprocal crowd controller, rather than proposing
        // straight overlapping paths and repeatedly stopping everyone involved.
        // Its velocity units use WALKING_SPEED; scaling the movement interval
        // preserves the configured survivor speed through every correction.
        let movement_dt =
            scenario.time_step_seconds * config.survivor_speed / motion::WALKING_SPEED;
        let budget = config.survivor_speed * scenario.time_step_seconds;
        let active: Vec<_> = gone.iter().map(|g| !g).collect();
        let mut targets = vec![None; people.len()];
        let mut limits = vec![Vec::new(); people.len()];
        for i in 0..people.len() {
            if gone[i] {
                continue;
            }
            if let Some(route) = &mut routes[i] {
                // Lateral avoidance need not return to a waypoint it has passed.
                while route.waypoints.len() > 1
                    && math::distance_to_point(before[i], route.waypoints[0]) <= budget
                    && geometry.can_move(before[i], route.waypoints[1])
                {
                    route.waypoints.remove(0);
                }
                if route.waypoints.len() == 1
                    && let Some((start, end)) = geometry.exit_segment(&route.exit_id)
                {
                    let target = math::closest_point_on_segment(before[i], start, end);
                    if geometry.can_move(before[i], target) {
                        route.waypoints[0] = target;
                    }
                }
                targets[i] = route.waypoints.first().copied();
            }
            limits[i] = geometry.velocity_limits(before[i], movement_dt);
        }
        let neighbors = |i: usize, velocities: &[Point]| -> Vec<_> {
            before
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i && !gone[*j])
                .map(|(j, &position)| motion::Neighbor {
                    position,
                    velocity: velocities[j],
                    responsibility: if targets[j].is_none() { 1.0 } else { 0.5 },
                    horizon: routes[i]
                        .as_ref()
                        .zip(routes[j].as_ref())
                        .filter(|(a, b)| a.exit_id == b.exit_id)
                        .map_or(1.5, |(a, _)| {
                            let exit = *a.waypoints.last().unwrap();
                            (math::distance_to_point(before[i], exit)
                                .min(math::distance_to_point(position, exit))
                                / motion::WALKING_SPEED
                                + movement_dt)
                                .min(1.5)
                        }),
                })
                .collect()
        };
        let previous: Vec<_> = controllers.iter().map(|m| m.velocity()).collect();
        let intents: Vec<_> = (0..people.len())
            .map(|i| {
                targets[i].map_or(Point { x: 0.0, y: 0.0 }, |target| {
                    controllers[i].preferred_velocity(
                        before[i],
                        target,
                        movement_dt,
                        scenario.agent_radius,
                        &neighbors(i, &previous),
                        &limits[i],
                    )
                })
            })
            .collect();
        let mut proposed = before.clone();
        for i in 0..people.len() {
            let Some(target) = targets[i] else {
                continue;
            };
            let mut candidate = controllers[i].propose(
                before[i],
                intents[i],
                movement_dt,
                scenario.agent_radius,
                &neighbors(i, &intents),
                limits[i].clone(),
            );
            // Finish the last short segment exactly instead of asymptotically
            // stopping at the exit plane or a visibility-graph corner.
            if math::distance_to_point(before[i], target) <= budget
                && geometry.can_move(before[i], target)
            {
                candidate = target;
            }
            candidate.x = candidate.x.clamp(0.0, scenario.width);
            candidate.y = candidate.y.clamp(0.0, scenario.height);
            if geometry.can_move(before[i], candidate) {
                proposed[i] = candidate;
            }
        }
        let compliance: Vec<_> = targets
            .iter()
            .map(|t| if t.is_some() { 1.0 } else { 0.0 })
            .collect();
        motion::coordinate_moves(
            &before,
            &mut proposed,
            &active,
            &compliance,
            scenario.agent_radius,
            movement_dt,
            &limits,
        );
        for i in 0..people.len() {
            proposed[i].x = proposed[i].x.clamp(0.0, scenario.width);
            proposed[i].y = proposed[i].y.clamp(0.0, scenario.height);
            if !geometry.can_move(before[i], proposed[i]) {
                proposed[i] = before[i];
            }
        }
        motion::resolve_collisions(&before, &mut proposed, &active, scenario.agent_radius);
        let hunter_before = stalker;
        stalker = advance(
            stalker,
            &mut hunter_route,
            config.stalker_speed * scenario.time_step_seconds,
            &geometry,
        );
        for i in 0..people.len() {
            control::checkpoint()?;
            if gone[i] {
                continue;
            }
            // Collision resolver may adjust movement; retain the final world check.
            if !geometry.can_move(before[i], proposed[i]) {
                proposed[i] = before[i];
            }
            controllers[i].accepted(before[i], proposed[i], movement_dt);
            people[i].position = proposed[i];
            if contact(
                before[i],
                proposed[i],
                hunter_before,
                stalker,
                config.capture_radius,
                &geometry,
            ) {
                caught.push(CaughtAgent {
                    agent_id: people[i].id,
                    step: step + 1,
                });
                gone[i] = true;
            } else if routes[i]
                .as_ref()
                .is_some_and(|r| geometry.at_exit(proposed[i], &r.exit_id))
            {
                escaped += 1;
                gone[i] = true;
            }
        }
        step += 1;
    }
    let remaining = total - escaped;
    let result = SimulationResult {
        metrics: SimulationMetrics {
            status: if remaining == 0 {
                SimulationStatus::Completed
            } else if gone.iter().all(|g| *g) {
                SimulationStatus::Incomplete
            } else {
                SimulationStatus::Timeout
            },
            total_population: total,
            evacuated: escaped,
            remaining,
            trapped: 0,
            sheltered: 0,
            clearance_steps: (remaining == 0).then_some(step),
            evacuated_by_route: None,
        },
        frames,
        traffic_samples: traffic.into_values().collect(),
        width: scenario.width,
        height: scenario.height,
        time_step_seconds: scenario.time_step_seconds,
        analytics: None,
        communication_events: None,
        agent_events: None,
        termination_reason: None,
    };
    result
        .validate()
        .map_err(SimulationError::InvalidScenario)?;
    control::checkpoint()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn room() -> BuildingScenario {
        serde_json::from_value(serde_json::json!({
            "width":10,"height":10,"walls":[
              {"id":"west","start":{"x":0,"y":0},"end":{"x":0,"y":10},"thickness":0.1},
              {"id":"east","start":{"x":10,"y":0},"end":{"x":10,"y":10},"thickness":0.1}
            ], "doors":[],"exits":[
              {"id":"west-out","wall_id":"west","offset":4,"width":2},
              {"id":"east-out","wall_id":"east","offset":4,"width":2}
            ],"spawn_zones":[{"id":"person","x":4.8,"y":4.8,"width":0.4,"height":0.4,"count":1}],
            "obstructions":[],"blocked_exit_ids":[],"agent_radius":0.2,"time_step_seconds":0.1,"seed":42,"max_steps":100,
            "pursuit":{"stalker_start":{"x":2,"y":5},"stalker_speed":0.1,"survivor_speed":1.3,"capture_radius":0.45,"avoidance_radius":3}
        })).unwrap()
    }
    #[test]
    fn visible_stalker_changes_exit_choice_without_becoming_an_invisible_wall() {
        let b = room();
        let hunted = super::super::simulate(&b).unwrap();
        let mut calm = b.clone();
        calm.pursuit = None;
        let ordinary = super::super::simulate(&calm).unwrap();
        assert!(
            hunted.frames[10].agents[0].x > 5.0,
            "choose the exit away from the stalker"
        );
        assert!(
            ordinary.frames[10].agents[0].x < 5.0,
            "without pursuit the tied nearest route is west"
        );
        assert_eq!(hunted.metrics.evacuated, 1);
    }
    #[test]
    fn swept_contact_catches_crossing_paths_but_never_through_walls_or_furniture() {
        let b = room();
        let clear = Geometry::new(&b);
        assert!(contact(
            Point { x: 4.0, y: 5.0 },
            Point { x: 6.0, y: 5.0 },
            Point { x: 6.0, y: 5.0 },
            Point { x: 4.0, y: 5.0 },
            0.5,
            &clear
        ));
        let mut blocked = b.clone();
        blocked.walls.push(crate::models::Wall {
            id: "partition".into(),
            name: None,
            start: Point { x: 5.0, y: 0.0 },
            end: Point { x: 5.0, y: 10.0 },
            thickness: 0.1,
        });
        let wall = Geometry::new(&blocked);
        let left = Point { x: 4.7, y: 5.0 };
        let right = Point { x: 5.3, y: 5.0 };
        assert!(!contact(left, left, right, right, 1.0, &wall));
        blocked.walls.pop();
        blocked.obstructions.push(crate::models::Obstruction {
            id: "cabinet".into(),
            name: None,
            x: 4.9,
            y: 4.0,
            width: 0.2,
            height: 2.0,
        });
        let furniture = Geometry::new(&blocked);
        assert!(!contact(left, left, right, right, 1.0, &furniture));
    }
    #[test]
    fn house_frames_respect_swept_wall_furniture_and_survivor_collision() {
        let b: BuildingScenario = serde_json::from_str(include_str!(
            "../../../frontend/src/editor/presets/halloween-pursuit.json"
        ))
        .unwrap();
        let result = super::super::simulate(&b).unwrap();
        let geometry = Geometry::new(&b);
        for pair in result.frames.windows(2) {
            let a = &pair[0];
            let z = &pair[1];
            let config = b.pursuit.as_ref().unwrap();
            let h0 = a.pursuit.as_ref().unwrap().stalker;
            let h1 = z.pursuit.as_ref().unwrap().stalker;
            assert!(
                geometry.can_move(h0, h1),
                "stalker cannot tunnel through geometry"
            );
            assert!(
                math::distance_to_point(h0, h1)
                    <= config.stalker_speed * b.time_step_seconds + 1e-8
            );
            for person in &z.agents {
                let before = a.agents.iter().find(|a| a.id == person.id).unwrap();
                let p0 = Point {
                    x: before.x,
                    y: before.y,
                };
                let p1 = Point {
                    x: person.x,
                    y: person.y,
                };
                assert!(geometry.can_move(p0, p1));
                assert!(
                    math::distance_to_point(p0, p1)
                        <= config.survivor_speed * b.time_step_seconds + 1e-8
                );
                for other in z.agents.iter().filter(|a| a.id != person.id) {
                    assert!(
                        (person.x - other.x).hypot(person.y - other.y)
                            >= 2.0 * b.agent_radius - 1e-8
                    );
                }
            }
        }
    }
}
