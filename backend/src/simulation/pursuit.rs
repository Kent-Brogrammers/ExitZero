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
    pursuit_awareness::PursuitAwareness,
    record_traffic,
    windows::Windows,
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
    if route.waypoints.len() == 1 {
        // Keep the nearest body-clear arrival point after lateral corrections.
        if let Some(target) = geometry
            .exit_segments(&route.exit_id)
            .into_iter()
            .map(|(a, b)| math::closest_point_on_segment(position, a, b))
            .filter(|&p| geometry.can_move(position, p))
            .min_by(|&a, &b| {
                math::distance_to_point(position, a)
                    .total_cmp(&math::distance_to_point(position, b))
            })
        {
            route.waypoints[0] = target;
        }
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
) -> Option<Point> {
    let relative = Point {
        x: a.x - hunter_before.x,
        y: a.y - hunter_before.y,
    };
    let velocity = Point {
        x: b.x - a.x - hunter_after.x + hunter_before.x,
        y: b.y - a.y - hunter_after.y + hunter_before.y,
    };
    let squared = velocity.x * velocity.x + velocity.y * velocity.y;
    let separation = relative.x * relative.x + relative.y * relative.y - radius * radius;
    let t = if separation <= 1e-10 {
        0.0
    } else {
        if squared < 1e-12 {
            return None;
        }
        let approach = relative.x * velocity.x + relative.y * velocity.y;
        let discriminant = approach * approach - squared * separation;
        if discriminant < 0.0 {
            return None;
        }
        let first_touch = (-approach - discriminant.sqrt()) / squared;
        if !(0.0..=1.0).contains(&first_touch) {
            return None;
        }
        first_touch
    };
    let survivor = math::interpolate(a, b, t);
    let stalker = math::interpolate(hunter_before, hunter_after, t);
    // Freeze at the first physical contact, without a wind-up or a further move.
    // The swept body check prevents catches through walls, panes and furniture.
    geometry.can_move(stalker, survivor).then_some(survivor)
}

fn snapshot(
    step: u32,
    people: &[Agent],
    gone: &[bool],
    pursuit: PursuitFrame,
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
        pursuit: Some(pursuit),
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
    let contact_radius = config.capture_radius.min(2.0 * scenario.agent_radius);
    if !geometry.can_stand_at(stalker)
        || people
            .iter()
            .any(|a| math::distance_to_point(a.position, stalker) <= contact_radius)
    {
        return Err(SimulationError::InvalidScenario(
            "Stalker start must be clear of walls, furniture and survivor spawn positions".into(),
        ));
    }
    let total = people.len() as u32;
    let mut gone = vec![false; people.len()];
    let mut controllers: Vec<_> = people.iter().map(|_| motion::Motion::new()).collect();
    let mut routes: Vec<Option<Route>> = people.iter().map(|_| None).collect();
    let mut hunter_route = None;
    let mut retarget = true;
    let mut caught = Vec::new();
    let mut awareness = PursuitAwareness::new(people.len());
    let mut escaped = 0;
    let mut window_escapes = 0;
    let mut windows = Windows::new(scenario, &[], world.blocked(), people.len(), &geometry);
    let mut frames = Vec::new();
    let mut traffic = BTreeMap::new();
    let replan_stride = (0.5 / scenario.time_step_seconds).ceil().max(1.0) as u32;
    let frame_stride = (u64::from(total) * (u64::from(scenario.max_steps) + 1))
        .div_ceil(200_000)
        .max(1) as u32;
    let mut step = 0;
    let mut last_outcomes = (0, 0);
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
            windows.refresh(&[], world.blocked(), &geometry);
        }
        let alerted = awareness.update(
            step,
            &people,
            &gone,
            stalker,
            &scenario.awareness,
            &geometry,
        );
        for (i, person) in people.iter().enumerate().filter(|(i, _)| !gone[*i]) {
            if changed || alerted[i] || step % replan_stride == 0 {
                control::checkpoint()?;
                let forecast = if let Some(report) = awareness.known[i] {
                    CrowdForecast::for_pursuit(&geometry, report.position, config.avoidance_radius)
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
        }
        // Reuse real preparation, FIFO service and collision-checked traversal
        // only for survivors with no usable normal exit route.
        let fallback: Vec<_> = routes.iter().map(Option::is_none).collect();
        windows.update(step, &people, &gone, &fallback, &geometry);
        let mut frame = snapshot(
            step,
            &people,
            &gone,
            PursuitFrame {
                stalker,
                escaped,
                caught: caught.clone(),
                events: Some(awareness.events.clone()),
            },
            &world,
        );
        frame.window_states = windows.snapshots(&people);
        if let Some(callback) = &mut emit
            && !callback(&frame)
        {
            return Err(SimulationError::Cancelled);
        }
        let finished = gone.iter().all(|&g| g) || step == scenario.max_steps;
        if step % frame_stride == 0 || finished || last_outcomes != (escaped, caught.len()) {
            frames.push(frame);
            last_outcomes = (escaped, caught.len());
        }
        record_traffic(scenario, &people, &gone, &mut traffic);
        if finished {
            break;
        }
        if changed || retarget || step % replan_stride == 0 {
            retarget = false;
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
                navigation
                    .with_point_target("pursuit-target".into(), person.position)
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
            if windows.controls(i) {
                targets[i] = windows.target(i, before[i], &geometry);
            } else if let Some(route) = &mut routes[i] {
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
            limits[i] = windows
                .geometry(i, &geometry)
                .velocity_limits(before[i], movement_dt);
            limits[i].extend(windows.approach_limits(i, before[i], movement_dt));
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
            let allowed = windows.movement_budget(i, budget);
            if windows.traversing(i) {
                candidate = math::move_toward(before[i], target, allowed);
            }
            // Finish the last short segment exactly instead of asymptotically
            // stopping at the exit plane or a visibility-graph corner.
            if math::distance_to_point(before[i], target) <= allowed
                && windows.geometry(i, &geometry).can_move(before[i], target)
            {
                candidate = target;
            }
            candidate.x = candidate.x.clamp(0.0, scenario.width);
            candidate.y = candidate.y.clamp(0.0, scenario.height);
            candidate = math::move_toward(before[i], candidate, allowed);
            if windows
                .geometry(i, &geometry)
                .can_move(before[i], candidate)
            {
                proposed[i] = candidate;
            }
        }
        let compliance: Vec<_> = targets
            .iter()
            .enumerate()
            .map(|(i, t)| {
                if windows.controls(i) {
                    if windows.traversing(i) || windows.has_priority(i) {
                        0.0
                    } else {
                        1.0
                    }
                } else if t.is_some() {
                    1.0
                } else {
                    0.0
                }
            })
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
            proposed[i] =
                math::move_toward(before[i], proposed[i], windows.movement_budget(i, budget));
            if !windows
                .geometry(i, &geometry)
                .can_move(before[i], proposed[i])
            {
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
            if !windows
                .geometry(i, &geometry)
                .can_move(before[i], proposed[i])
            {
                proposed[i] = before[i];
            }
            controllers[i].accepted(before[i], proposed[i], movement_dt);
            people[i].position = proposed[i];
            if let Some(position) = contact(
                before[i],
                proposed[i],
                hunter_before,
                stalker,
                contact_radius,
                &geometry,
            ) {
                caught.push(CaughtAgent {
                    agent_id: people[i].id,
                    step: step + 1,
                    position: Some(position),
                });
                people[i].position = position;
                gone[i] = true;
                windows.cancel(i);
                retarget = true;
            } else if scenario
                .exits
                .iter()
                .any(|exit| geometry.at_exit(proposed[i], &exit.id))
            {
                escaped += 1;
                gone[i] = true;
                retarget = true;
            }
        }
        for (i, _) in windows.finish(step + 1, &people) {
            escaped += 1;
            window_escapes += 1;
            gone[i] = true;
            retarget = true;
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
            evacuated_by_route: (!scenario.windows.is_empty()).then_some(
                crate::models::EvacuatedByRoute {
                    normal_exit: escaped - window_escapes,
                    emergency_window: window_escapes,
                },
            ),
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
    fn nearby_survivors_clear_a_shared_exit_while_stalker_is_far_away() {
        let mut b = room();
        b.exits.retain(|e| e.id == "east-out");
        b.exits[0].offset = 4.5;
        b.exits[0].width = 1.0;
        b.spawn_zones[0].x = 6.5;
        b.spawn_zones[0].y = 3.5;
        b.spawn_zones[0].width = 2.0;
        b.spawn_zones[0].height = 3.0;
        b.spawn_zones[0].count = 8;
        b.max_steps = 250;
        for seed in 0..5 {
            b.seed = seed;
            let result = super::super::simulate(&b).unwrap();
            assert_eq!(
                result.metrics.evacuated,
                8,
                "a collision-safe exit queue must drain, seed {seed}: {:?}",
                result.frames.last().unwrap()
            );
        }
    }

    #[test]
    fn a_genuine_warning_changes_an_unseeing_survivors_exit_choice() {
        let b = room();
        let geometry = Geometry::new(&b);
        let navigation = Navigation::new(&b, &geometry);
        let people = vec![
            Agent::new(0, Point { x: 3.5, y: 5.0 }),
            Agent::new(1, Point { x: 5.0, y: 5.0 }),
        ];
        assert_eq!(
            navigation
                .find_route(people[1].position, &geometry)
                .unwrap()
                .exit_id,
            "west-out"
        );
        let mut awareness = PursuitAwareness::new(2);
        let settings = crate::models::AgentAwareness {
            sight_range_metres: 2.0,
            communication_range_metres: 2.0,
        };
        let alerted = awareness.update(
            0,
            &people,
            &[false, false],
            Point { x: 2.0, y: 5.0 },
            &settings,
            &geometry,
        );
        assert!(alerted[1]);
        assert_eq!(awareness.events[1].recipient_ids, vec![1]);
        let forecast =
            CrowdForecast::for_pursuit(&geometry, awareness.known[1].unwrap().position, 3.0);
        assert_eq!(
            navigation
                .find_route_with_forecast(people[1].position, &geometry, &forecast, b.agent_radius)
                .unwrap()
                .exit_id,
            "east-out"
        );
    }
    #[test]
    fn a_disabled_or_body_narrow_exit_never_counts_as_an_escape() {
        let mut b = room();
        b.exits.retain(|e| e.id == "east-out");
        b.blocked_exit_ids.push("east-out".into());
        b.max_steps = 80;
        assert_eq!(super::super::simulate(&b).unwrap().metrics.evacuated, 0);
        b.blocked_exit_ids.clear();
        b.exits[0].width = 0.3;
        assert_eq!(super::super::simulate(&b).unwrap().metrics.evacuated, 0);
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
        let first = contact(
            Point { x: 4.0, y: 5.0 },
            Point { x: 6.0, y: 5.0 },
            Point { x: 6.0, y: 5.0 },
            Point { x: 4.0, y: 5.0 },
            0.5,
            &clear,
        )
        .unwrap();
        assert!(
            (first.x - 4.75).abs() < 1e-8,
            "stop at first touch, not the end of the tick"
        );
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
        assert!(contact(left, left, right, right, 1.0, &wall).is_none());
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
        assert!(contact(left, left, right, right, 1.0, &furniture).is_none());
    }
    #[test]
    fn first_contact_is_caught_in_the_same_tick_and_the_stalker_retargets_without_waiting() {
        let mut b = room();
        b.pursuit.as_mut().unwrap().stalker_start = Point { x: 4.58, y: 5.0 };
        b.pursuit.as_mut().unwrap().stalker_speed = 3.0;
        b.pursuit.as_mut().unwrap().survivor_speed = 0.1;
        b.spawn_zones.push(crate::models::SpawnZone {
            polygon: None,
            id: "second".into(),
            name: None,
            x: 5.4,
            y: 4.8,
            width: 0.4,
            height: 0.4,
            count: 1,
        });
        b.max_steps = 4; // Earlier than the ordinary five-tick hunter replan.
        let result = super::super::simulate(&b).unwrap();
        let first = &result.frames[1];
        assert_eq!(first.step, 1);
        let capture = &first.pursuit.as_ref().unwrap().caught[0];
        assert_eq!(capture.agent_id, 0);
        assert_eq!(capture.step, 1, "no attack timer after body contact");
        assert!(
            capture.position.unwrap().x < 5.01,
            "freeze at first contact"
        );
        assert!(!first.agents.iter().any(|a| a.id == 0));
        let end = result.frames.last().unwrap().pursuit.as_ref().unwrap();
        assert_eq!(end.caught.len(), 2, "immediately pursue the next survivor");
        assert_eq!(
            end.caught[0].position.unwrap().x,
            capture.position.unwrap().x
        );
    }
    #[test]
    fn house_frames_respect_swept_wall_furniture_and_survivor_collision() {
        let b: BuildingScenario = serde_json::from_str(include_str!(
            "../../../frontend/src/editor/presets/halloween-pursuit.json"
        ))
        .unwrap();
        let result = super::super::simulate(&b).unwrap();
        for pair in result.frames.windows(2) {
            let a = &pair[0];
            let z = &pair[1];
            let blocked: std::collections::BTreeSet<_> = a
                .blocked_opening_ids
                .as_ref()
                .unwrap()
                .iter()
                .cloned()
                .collect();
            let geometry = Geometry::with_blocked_openings(&b, &[], blocked.clone());
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
                let crossing = a
                    .window_states
                    .iter()
                    .flatten()
                    .chain(z.window_states.iter().flatten())
                    .find(|s| s.traversing_agent_id == Some(person.id))
                    .map(|s| {
                        Geometry::with_window_aperture(
                            &b,
                            &[],
                            blocked.clone(),
                            b.windows.iter().find(|w| w.id == s.window_id).unwrap(),
                        )
                    });
                assert!(
                    crossing.as_ref().unwrap_or(&geometry).can_move(p0, p1),
                    "only a serviced window may be crossed"
                );
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
