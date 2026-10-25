use self::agent::Agent;
use crate::models::{
    AgentPosition, AgentStatistics, AnimationFrame, BuildingScenario, Point, SimulationMetrics,
    SimulationResult, SimulationStatus, TrafficSample,
};
use std::{collections::BTreeMap, fmt};
mod agent;
mod analytics;
mod awareness;
mod emergency;
mod geometry;
mod math;
mod motion;
mod navigation;
mod perception;
pub use emergency::Emergency;

#[cfg(test)]
mod tests;

#[derive(Debug)]
pub enum SimulationError {
    InvalidScenario(String),
    NotImplemented,
    Cancelled,
}

impl fmt::Display for SimulationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidScenario(message) => write!(f, "{message}"),
            Self::NotImplemented => write!(f, "simulation engine is not implemented"),
            Self::Cancelled => write!(f, "simulation cancelled"),
        }
    }
}

impl std::error::Error for SimulationError {}

/// Continuous reactive crowd model. Agents walk at up to 1.3 m/s and evacuate
/// upon reaching an available exit's centre; this does not certify outdoors.
pub fn simulate(scenario: &BuildingScenario) -> Result<SimulationResult, SimulationError> {
    simulate_with_emergencies(scenario, &[])
}

/// Circular emergencies are static for this run. Door/exit states can change
/// through opening_events and are learned independently by each agent.
/// The existing API entry point remains compatible and runs without hazards.
pub fn simulate_with_emergencies(
    scenario: &BuildingScenario,
    emergencies: &[Emergency],
) -> Result<SimulationResult, SimulationError> {
    run(scenario, emergencies, None)
}

/// Observe actual physics frames before completion. Returning false cancels the
/// run, allowing a disconnected live viewer to release the simulation worker.
pub fn simulate_live(
    scenario: &BuildingScenario,
    on_frame: &mut dyn FnMut(&AnimationFrame) -> bool,
) -> Result<SimulationResult, SimulationError> {
    run(scenario, &[], Some(on_frame))
}

fn run(
    scenario: &BuildingScenario,
    emergencies: &[Emergency],
    mut on_frame: Option<&mut dyn FnMut(&AnimationFrame) -> bool>,
) -> Result<SimulationResult, SimulationError> {
    scenario
        .validate()
        .map_err(SimulationError::InvalidScenario)?;

    if emergencies.len() > 100 {
        return Err(SimulationError::InvalidScenario(
            "at most 100 emergencies are supported".into(),
        ));
    }
    for emergency in emergencies {
        emergency
            .validate(scenario)
            .map_err(SimulationError::InvalidScenario)?;
    }

    //Spawning Agents
    let mut agents: Vec<Agent> = Vec::new();
    let mut world = awareness::OpeningStates::new(scenario);
    let mut geometry = if emergencies.is_empty() {
        geometry::Geometry::new(scenario)
    } else {
        geometry::Geometry::with_emergencies(scenario, emergencies)
    };
    if world.apply(0, &[], &[]) {
        geometry =
            geometry::Geometry::with_blocked_openings(scenario, emergencies, world.blocked());
    }
    agent::spawn_agents(&mut agents, scenario, &geometry)?;

    let mut beliefs = awareness::BeliefMaps::new(scenario, emergencies);
    let mut routes: Vec<_> = agents
        .iter()
        .map(|agent| {
            let (map, navigation) = beliefs.for_agent(agent);
            navigation.find_route(agent.position, map)
        })
        .collect();
    let mut next_waypoint = vec![0; agents.len()];
    let mut motion: Vec<_> = agents.iter().map(|_| motion::Motion::new()).collect();
    let retry_ticks = (2.0 / scenario.time_step_seconds).ceil() as u32;
    let mut stalled_ticks = vec![0_u32; agents.len()];
    let mut statistics: Vec<_> = agents
        .iter()
        .zip(&routes)
        .map(|(agent, route)| AgentStatistics {
            id: agent.id,
            distance_metres: 0.0,
            waiting_steps: 0,
            waiting_seconds: 0.0,
            elapsed_seconds: 0.0,
            evacuation_step: None,
            evacuation_seconds: None,
            exit_id: None,
            route_found: route.is_some(),
        })
        .collect();
    let mut evacuated = vec![false; agents.len()];
    let total_population = agents.len() as u32;
    let mut evacuated_count = 0;
    let mut step = 0;
    let mut idle_steps = 0;
    let movement_budget = motion::WALKING_SPEED * scenario.time_step_seconds;

    // Bound animation output by sampling ticks, retaining initial/final frames.
    // Physics and traffic still update every tick.
    let frame_stride = ((u64::from(total_population) * (u64::from(scenario.max_steps) + 1))
        .div_ceil(200_000))
    .max(1) as u32;
    let mut frames = vec![frame(0, &agents, &evacuated, &world)];
    let live_stride = (0.05 / scenario.time_step_seconds).ceil().max(1.0) as u32;
    let mut last_live_step = 0;
    if let Some(emit) = &mut on_frame
        && !emit(&frames[0])
    {
        return Err(SimulationError::Cancelled);
    }
    let mut traffic = BTreeMap::new();
    record_traffic(scenario, &agents, &evacuated, &mut traffic);

    let status = loop {
        if evacuated_count == total_population {
            break SimulationStatus::Completed;
        }
        let previous_blocks: Vec<_> = agents.iter().map(awareness::blocked_ids).collect();
        let (changed_beliefs, information_changed) =
            awareness::update_knowledge(&mut agents, &evacuated, &world, &geometry);
        for i in 0..agents.len() {
            if evacuated[i] || !changed_beliefs[i] {
                continue;
            }
            // Keep useful guidance as visible fragments grow. Rebuild the
            // graph only when new knowledge invalidates it or a passage changes.
            let map = beliefs.geometry_for_agent(&agents[i]);
            let mut from = agents[i].position;
            let valid = routes[i].as_ref().is_some_and(|route| {
                route.waypoints[next_waypoint[i]..].iter().all(|&to| {
                    let clear = map.can_move(from, to);
                    from = to;
                    clear
                })
            });
            if valid && previous_blocks[i] == awareness::blocked_ids(&agents[i]) {
                continue;
            }
            let (map, navigation) = beliefs.for_agent(&agents[i]);
            routes[i] = navigation.find_route(agents[i].position, map);
            statistics[i].route_found = routes[i].is_some();
            next_waypoint[i] = 0;
            stalled_ticks[i] = 0;
        }
        if !routes
            .iter()
            .enumerate()
            .any(|(i, route)| !evacuated[i] && route.is_some())
            && !world.has_pending_changes()
            && !information_changed
        {
            break SimulationStatus::Incomplete;
        }
        if step == scenario.max_steps {
            break SimulationStatus::Timeout;
        }

        let before: Vec<Point> = agents.iter().map(|agent| agent.position).collect();
        let previous_velocities: Vec<_> = motion.iter().map(motion::Motion::velocity).collect();
        // Centre-arrival remains compatible with result consumers. The closest
        // visible person gets approach priority; everybody still performs local
        // avoidance. This does not model the full capacity of a wide opening.
        let mut exit_leaders: BTreeMap<String, (usize, f64)> = BTreeMap::new();
        for (i, route) in routes.iter().enumerate() {
            if evacuated[i] {
                continue;
            }
            let Some(route) = route else { continue };
            let Some(&target) = route.waypoints.last() else {
                continue;
            };
            let distance = math::distance_to_point(before[i], target);
            // Approach priority must use the person's beliefs too. Testing the
            // actual closure here leaks unseen exit state into crowd steering.
            let map = beliefs.geometry_for_agent(&agents[i]);
            if !map.can_move(before[i], target) {
                continue;
            }
            let leader = exit_leaders
                .entry(route.exit_id.clone())
                .or_insert((i, distance));
            if distance < leader.1 || (distance == leader.1 && agents[i].id < agents[leader.0].id) {
                *leader = (i, distance);
            }
        }
        let mut proposed = before.clone();
        let active: Vec<_> = evacuated.iter().map(|gone| !gone).collect();
        let mut targets = vec![None; agents.len()];
        let mut velocity_limits = vec![Vec::new(); agents.len()];

        // Guidance can change with congestion, but avoidance is active on every
        // tick, including the very first one. All people see the same snapshot.
        for i in 0..agents.len() {
            if evacuated[i] {
                continue;
            }
            let map = beliefs.geometry_for_agent(&agents[i]);
            let lost_sight = routes[i]
                .as_ref()
                .is_some_and(|route| !map.can_move(before[i], route.waypoints[next_waypoint[i]]));
            if lost_sight
                || (stalled_ticks[i] >= retry_ticks && stalled_ticks[i].is_multiple_of(retry_ticks))
            {
                let occupants: Vec<_> = before
                    .iter()
                    .enumerate()
                    .filter(|(j, _)| *j != i && !evacuated[*j])
                    .map(|(_, &position)| position)
                    .collect();
                let (map, navigation) = beliefs.for_agent(&agents[i]);
                if let Some(route) = navigation.find_route_with_crowd(
                    before[i],
                    map,
                    &occupants,
                    scenario.agent_radius,
                ) {
                    routes[i] = Some(route);
                    next_waypoint[i] = 0;
                }
            }
            let Some(route) = &routes[i] else {
                continue;
            };
            let map = beliefs.geometry_for_agent(&agents[i]);
            for future in (next_waypoint[i] + 1..route.waypoints.len()).rev() {
                if map.can_move(before[i], route.waypoints[future]) {
                    next_waypoint[i] = future;
                    break;
                }
            }
            let waypoint = route.waypoints[next_waypoint[i]];
            targets[i] = Some(waypoint);
            velocity_limits[i] = geometry.velocity_limits(before[i], scenario.time_step_seconds);
            if next_waypoint[i] + 1 == route.waypoints.len()
                && geometry.can_move(before[i], waypoint)
            {
                // Followers leave a body-sized arrival lane for the leader;
                // otherwise they can crowd the plane and obstruct its centre.
                velocity_limits[i].extend(
                    geometry.exit_approach_limits(
                        before[i],
                        &route.exit_id,
                        scenario.time_step_seconds,
                        if exit_leaders
                            .get(&route.exit_id)
                            .is_some_and(|&(leader, _)| leader == i)
                        {
                            0.0
                        } else {
                            2.0 * scenario.agent_radius + 1e-4
                        },
                    ),
                );
            }
        }
        let previous_neighbors = |i: usize| -> Vec<_> {
            before
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i && !evacuated[*j])
                .map(|(j, &position)| motion::Neighbor {
                    position,
                    velocity: previous_velocities[j],
                    responsibility: if routes[j].is_some() { 0.5 } else { 1.0 },
                    horizon: 1.5,
                })
                .collect()
        };
        let intents: Vec<_> = (0..agents.len())
            .map(|i| {
                let Some(target) = targets[i] else {
                    return Point { x: 0.0, y: 0.0 };
                };
                motion[i].preferred_velocity(
                    before[i],
                    target,
                    scenario.time_step_seconds,
                    scenario.agent_radius,
                    &previous_neighbors(i),
                    &velocity_limits[i],
                )
            })
            .collect();
        for i in 0..agents.len() {
            let Some(waypoint) = targets[i] else {
                continue;
            };
            let route = routes[i].as_ref().unwrap();
            let exit = *route.waypoints.last().unwrap();
            let neighbors: Vec<_> = before
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i && !evacuated[*j])
                .map(|(j, &position)| motion::Neighbor {
                    position,
                    velocity: intents[j],
                    responsibility: if routes[j].is_none() {
                        1.0
                    } else if routes[j]
                        .as_ref()
                        .is_some_and(|other| other.exit_id == route.exit_id)
                    {
                        match exit_leaders.get(&route.exit_id).map(|&(index, _)| index) {
                            Some(leader) if leader == i => 0.05,
                            Some(leader) if leader == j => 0.95,
                            _ => 0.5,
                        }
                    } else {
                        0.5
                    },
                    horizon: if routes[j]
                        .as_ref()
                        .is_some_and(|other| other.exit_id == route.exit_id)
                    {
                        ((math::distance_to_point(before[i], exit)
                            .min(math::distance_to_point(position, exit)))
                            / motion::WALKING_SPEED
                            + scenario.time_step_seconds)
                            .min(1.5)
                    } else {
                        1.5
                    },
                })
                .collect();
            let mut candidate = motion[i].propose(
                before[i],
                intents[i],
                scenario.time_step_seconds,
                scenario.agent_radius,
                &neighbors,
                velocity_limits[i].clone(),
            );
            if exit_leaders
                .get(&route.exit_id)
                .is_some_and(|&(leader, _)| leader == i)
                && math::distance_to_point(before[i], exit)
                    <= 2.0 * scenario.agent_radius + movement_budget
                && geometry.can_move(before[i], exit)
            {
                let speed = (previous_velocities[i].x.hypot(previous_velocities[i].y)
                    + motion::ACCELERATION * scenario.time_step_seconds)
                    .min(motion::WALKING_SPEED);
                candidate = math::move_toward(before[i], exit, speed * scenario.time_step_seconds);
            }
            if math::distance_to_point(candidate, waypoint) < 1e-8 {
                candidate = waypoint;
            }
            // Projection onto a boundary can leave a negative coordinate a few
            // ulps below zero. Clamp before exact geometry/swept-disc checks.
            candidate.x = candidate.x.clamp(0.0, scenario.width);
            candidate.y = candidate.y.clamp(0.0, scenario.height);
            if geometry.can_move(before[i], candidate) {
                proposed[i] = candidate;
            }
        }
        let compliance: Vec<_> = (0..agents.len())
            .map(|i| {
                if targets[i].is_none() {
                    0.0
                } else if routes[i].as_ref().is_some_and(|route| {
                    exit_leaders
                        .get(&route.exit_id)
                        .is_some_and(|&(leader, _)| leader == i)
                }) {
                    if math::distance_to_point(
                        before[i],
                        *routes[i].as_ref().unwrap().waypoints.last().unwrap(),
                    ) <= movement_budget * 0.2
                    {
                        0.0
                    } else {
                        0.05
                    }
                } else {
                    1.0
                }
            })
            .collect();
        motion::coordinate_moves(
            &before,
            &mut proposed,
            &active,
            &compliance,
            scenario.agent_radius,
            scenario.time_step_seconds,
            &velocity_limits,
        );
        for i in 0..agents.len() {
            proposed[i].x = proposed[i].x.clamp(0.0, scenario.width);
            proposed[i].y = proposed[i].y.clamp(0.0, scenario.height);
            if !geometry.can_move(before[i], proposed[i]) {
                proposed[i] = before[i];
            }
        }
        motion::resolve_collisions(&before, &mut proposed, &active, scenario.agent_radius);
        let mut leaving = Vec::new();
        let mut progress = false;
        for i in 0..agents.len() {
            if evacuated[i] {
                continue;
            }
            let Some(waypoint) = targets[i] else {
                continue;
            };
            let travelled = math::distance_to_point(before[i], proposed[i]);
            agents[i].position = proposed[i];
            motion[i].accepted(before[i], proposed[i], scenario.time_step_seconds);
            statistics[i].distance_metres += travelled;
            if travelled <= math::EPSILON {
                statistics[i].waiting_steps += 1;
            }
            if math::distance_to_point(proposed[i], waypoint)
                < math::distance_to_point(before[i], waypoint) - movement_budget * 0.05
            {
                stalled_ticks[i] = 0;
            } else {
                stalled_ticks[i] += 1;
            }
            progress |= travelled > math::EPSILON;
            if math::distance_to_point(proposed[i], waypoint) <= math::EPSILON {
                next_waypoint[i] += 1;
                progress = true;
                if next_waypoint[i] == routes[i].as_ref().unwrap().waypoints.len()
                    && !world.states[&routes[i].as_ref().unwrap().exit_id].blocked
                {
                    leaving.push(i);
                }
            }
        }

        step += 1;
        // Include exit arrivals in traffic before removing evacuated agents.
        record_traffic(scenario, &agents, &evacuated, &mut traffic);
        for i in leaving {
            evacuated[i] = true;
            evacuated_count += 1;
            statistics[i].evacuation_step = Some(step);
            statistics[i].evacuation_seconds = Some(f64::from(step) * scenario.time_step_seconds);
            statistics[i].exit_id = routes[i].as_ref().map(|route| route.exit_id.clone());
        }
        if world.apply(step, &agents, &evacuated) {
            geometry =
                geometry::Geometry::with_blocked_openings(scenario, emergencies, world.blocked());
        }
        if step % frame_stride == 0 {
            frames.push(frame(step, &agents, &evacuated, &world));
        }
        if step.is_multiple_of(live_stride)
            && let Some(emit) = &mut on_frame
        {
            if !emit(&frame(step, &agents, &evacuated, &world)) {
                return Err(SimulationError::Cancelled);
            }
            last_live_step = step;
        }
        idle_steps = if progress || information_changed || world.has_pending_changes() {
            0
        } else {
            idle_steps + 1
        };
        // Allow rerouting before reporting a stalled run. Local avoidance has
        // already run on every tick; a stall still does not prove entrapment.
        if idle_steps >= agents.len().max(2 * retry_ticks as usize + 1) {
            break SimulationStatus::Incomplete;
        }
    };

    if frames.last().is_none_or(|last| last.step != step) {
        frames.push(frame(step, &agents, &evacuated, &world));
    }
    if last_live_step != step
        && let Some(emit) = &mut on_frame
        && !emit(frames.last().unwrap())
    {
        return Err(SimulationError::Cancelled);
    }
    // Graph-search failure alone is not proof of entrapment. We only classify
    // trapped occupants when every exit is explicitly disabled.
    let no_available_exits = scenario
        .exits
        .iter()
        .all(|exit| world.states[&exit.id].blocked);
    let remaining = total_population - evacuated_count;
    for agent in &mut statistics {
        agent.elapsed_seconds =
            f64::from(agent.evacuation_step.unwrap_or(step)) * scenario.time_step_seconds;
        agent.waiting_seconds = f64::from(agent.waiting_steps) * scenario.time_step_seconds;
    }
    let analytics = analytics::summarize(statistics, f64::from(step) * scenario.time_step_seconds);
    Ok(SimulationResult {
        metrics: SimulationMetrics {
            status,
            total_population,
            evacuated: evacuated_count,
            trapped: if no_available_exits { remaining } else { 0 },
            remaining,
            clearance_steps: (status == SimulationStatus::Completed).then_some(step),
        },
        frames,
        traffic_samples: traffic.into_values().collect(),
        width: scenario.width,
        height: scenario.height,
        time_step_seconds: scenario.time_step_seconds,
        analytics: Some(analytics),
    })
}

fn frame(
    step: u32,
    agents: &[Agent],
    evacuated: &[bool],
    world: &awareness::OpeningStates,
) -> AnimationFrame {
    AnimationFrame {
        blocked_opening_ids: Some(world.blocked().into_iter().collect()),
        step,
        agents: agents
            .iter()
            .zip(evacuated)
            .filter(|(_, gone)| !**gone)
            .map(|(agent, _)| AgentPosition {
                id: agent.id,
                x: agent.position.x,
                y: agent.position.y,
            })
            .collect(),
    }
}

fn record_traffic(
    scenario: &BuildingScenario,
    agents: &[Agent],
    evacuated: &[bool],
    traffic: &mut BTreeMap<(u32, u32), TrafficSample>,
) {
    // Spatial aggregation is only for the traffic visualization, not navigation.
    // Keep an actual observed world position as each bucket's representative.
    let bucket_size = scenario.width.max(scenario.height) / 128.0;
    for (agent, gone) in agents.iter().zip(evacuated) {
        if *gone {
            continue;
        }
        let key = (
            (agent.position.x / bucket_size).floor() as u32,
            (agent.position.y / bucket_size).floor() as u32,
        );
        let sample = traffic.entry(key).or_insert(TrafficSample {
            x: agent.position.x,
            y: agent.position.y,
            visits: 0,
        });
        sample.visits += 1;
    }
}
