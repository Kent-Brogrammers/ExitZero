use self::agent::Agent;
use crate::models::{
    AgentPosition, AgentStatistics, AnimationFrame, BuildingScenario, Point, SimulationMetrics,
    SimulationResult, SimulationStatus, TrafficSample,
};
use std::{collections::BTreeMap, fmt};
mod agent;
mod analytics;
mod awareness;
mod catastrophe;
mod congestion;
mod emergency;
mod evolution;
mod geometry;
mod math;
mod motion;
mod navigation;
mod perception;
mod windows;
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
/// upon reaching the usable width of an available exit; this does not certify outdoors.
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
    let mut crowd_memory: Vec<_> = agents
        .iter()
        .map(|_| congestion::CrowdMemory::default())
        .collect();
    let mut commitments: Vec<_> = agents
        .iter()
        .map(|_| congestion::RouteCommitment::default())
        .collect();
    let mut routed_disaster = vec![Vec::new(); agents.len()];
    let mut last_disaster_replan = vec![f64::NEG_INFINITY; agents.len()];
    let mut sheltered_count = 0;
    let tornado = scenario
        .disaster
        .is_some_and(|d| d.kind == crate::models::DisasterKind::Tornado);
    let mut statistics: Vec<_> = agents
        .iter()
        .zip(&routes)
        .map(|(agent, route)| AgentStatistics {
            shelter: None,
            injury: 0.0,
            exposure_seconds: 0.0,
            id: agent.id,
            distance_metres: 0.0,
            waiting_steps: 0,
            waiting_seconds: 0.0,
            elapsed_seconds: 0.0,
            evacuation_step: None,
            evacuation_seconds: None,
            exit_id: None,
            escape_route: None,
            route_found: route.is_some(),
        })
        .collect();
    let mut evacuated = vec![false; agents.len()];
    let total_population = agents.len() as u32;
    let mut evacuated_count = 0;
    let mut step = 0_u32;
    let mut idle_steps = 0;
    let mut communication_events = Vec::new();
    let movement_budget = motion::WALKING_SPEED * scenario.time_step_seconds;

    // Bound animation output by sampling ticks, retaining initial/final frames.
    // Physics and traffic still update every tick.
    let frame_stride = ((u64::from(total_population) * (u64::from(scenario.max_steps) + 1))
        .div_ceil(200_000))
    .max(1) as u32;
    let mut windows = windows::Windows::new(
        scenario,
        emergencies,
        world.blocked(),
        agents.len(),
        &geometry,
    );
    let mut all_exits_blocked = scenario.exits.iter().all(|e| world.states[&e.id].blocked);
    let mut window_fallback = vec![all_exits_blocked; agents.len()];
    windows.update(0, &agents, &evacuated, &window_fallback, &geometry);
    let mut window_escapes = 0;
    let mut frames = vec![frame(0, &agents, &evacuated, &world, &windows)];
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
        if evacuated_count + sheltered_count == total_population {
            break SimulationStatus::Completed;
        }
        let now = f64::from(step) * scenario.time_step_seconds;
        let (changed_beliefs, information_changed) = awareness::update_knowledge(
            &mut agents,
            &evacuated,
            &world,
            &geometry,
            |event_type, sender_id, opening_id, blocked, recipient_ids| {
                communication_events.push(crate::models::CommunicationEvent {
                    step,
                    event_type,
                    sender_id,
                    opening_id: opening_id.to_owned(),
                    blocked,
                    recipient_ids,
                });
            },
        );
        for i in 0..agents.len() {
            let versions: Vec<_> = agents[i]
                .known_hazards
                .values()
                .map(|area| (area.id, area.revision))
                .collect();
            let changed_disaster = versions != routed_disaster[i];
            if evacuated[i] || windows.controls(i) || (!changed_beliefs[i] && !changed_disaster) {
                continue;
            }
            let map = beliefs.geometry_for_agent(&agents[i]);
            let mut from = agents[i].position;
            let valid = routes[i].as_ref().is_some_and(|route| {
                !map.opening_is_unsafe(&route.exit_id)
                    && route.waypoints[next_waypoint[i]..].iter().all(|&to| {
                        let clear = map.can_move(from, to);
                        from = to;
                        clear
                    })
            });
            if valid && (!changed_disaster || now - last_disaster_replan[i] < 0.5) {
                continue;
            }
            let forecast = congestion::CrowdForecast::for_geometry(map);
            let current_cost = routes[i].as_ref().map(|route| {
                navigation::route_cost(
                    agents[i].position,
                    &route.waypoints[next_waypoint[i]..],
                    &forecast,
                    scenario.agent_radius,
                )
            });
            // Changing danger that does not intersect the remaining route
            // cannot improve safety. Avoid rebuilding a graph on every sighting.
            if valid
                && current_cost.is_some_and(|cost| {
                    let route = routes[i].as_ref().unwrap();
                    let distance = navigation::route_cost(
                        agents[i].position,
                        &route.waypoints[next_waypoint[i]..],
                        &congestion::CrowdForecast::default(),
                        scenario.agent_radius,
                    );
                    cost <= distance + math::EPSILON
                })
            {
                routed_disaster[i] = versions;
                last_disaster_replan[i] = now;
                continue;
            }
            let (map, navigation) = beliefs.for_agent(&agents[i]);
            let candidate = if windows.has_eligible() {
                navigation.find_safe_route_with_forecast(
                    agents[i].position,
                    map,
                    &forecast,
                    scenario.agent_radius,
                )
            } else {
                navigation.find_route_with_forecast(
                    agents[i].position,
                    map,
                    &forecast,
                    scenario.agent_radius,
                )
            };
            let improves = candidate.as_ref().is_some_and(|route| {
                current_cost.is_none_or(|current| {
                    navigation::route_cost(
                        agents[i].position,
                        &route.waypoints,
                        &forecast,
                        scenario.agent_radius,
                    ) + scenario.agent_radius
                        < current
                })
            });
            if !valid || improves {
                routes[i] = candidate;
                statistics[i].route_found = routes[i].is_some();
                next_waypoint[i] = 0;
                stalled_ticks[i] = 0;
                commitments[i].forced(now);
            }
            routed_disaster[i] = versions;
            last_disaster_replan[i] = now;
        }
        // An exit can remain physically open while known gas cuts off every
        // approach. Decide locally whether to try a window, searching for a
        // danger-free normal detour first. This is not proof of entrapment.
        for i in 0..agents.len() {
            if evacuated[i] || tornado || !windows.has_eligible() {
                window_fallback[i] = false;
                continue;
            }
            if all_exits_blocked {
                window_fallback[i] = true;
                continue;
            }
            if windows.controls(i)
                && window_fallback[i]
                && !changed_beliefs[i]
                && !step.is_multiple_of(retry_ticks)
            {
                continue;
            }
            let map = beliefs.geometry_for_agent(&agents[i]);
            let mut from = agents[i].position;
            let safe = routes[i].as_ref().is_some_and(|route| {
                !map.opening_is_unsafe(&route.exit_id)
                    && route.waypoints[next_waypoint[i]..].iter().all(|&to| {
                        let clear = map.can_move(from, to) && map.avoids_known_danger(from, to);
                        from = to;
                        clear
                    })
            });
            if safe {
                window_fallback[i] = false;
                continue;
            }
            let (map, navigation) = beliefs.for_agent(&agents[i]);
            let candidate = navigation.find_route_avoiding_danger(agents[i].position, map);
            window_fallback[i] = candidate.is_none();
            if let Some(route) = candidate {
                routes[i] = Some(route);
                next_waypoint[i] = 0;
                statistics[i].route_found = true;
                commitments[i].forced(now);
            }
        }
        let controlled: Vec<_> = (0..agents.len()).map(|i| windows.controls(i)).collect();
        windows.update(step, &agents, &evacuated, &window_fallback, &geometry);
        for i in 0..agents.len() {
            if windows.controls(i) {
                statistics[i].route_found = true;
            } else if controlled[i] && !evacuated[i] {
                let (map, navigation) = beliefs.for_agent(&agents[i]);
                routes[i] = if windows.has_eligible() {
                    navigation.find_route_avoiding_danger(agents[i].position, map)
                } else {
                    navigation.find_route(agents[i].position, map)
                };
                next_waypoint[i] = 0;
                stalled_ticks[i] = 0;
                statistics[i].route_found = routes[i].is_some();
                commitments[i].forced(now);
            }
        }
        if !windows.has_work()
            && !routes
                .iter()
                .enumerate()
                .any(|(i, route)| !evacuated[i] && route.is_some())
            && !world.has_pending_changes()
            && !information_changed
            && scenario.disaster.is_none()
        {
            break SimulationStatus::Incomplete;
        }
        if step == scenario.max_steps {
            break SimulationStatus::Timeout;
        }

        let before: Vec<Point> = agents.iter().map(|agent| agent.position).collect();
        let previous_velocities: Vec<_> = motion.iter().map(motion::Motion::velocity).collect();
        // Reassess moving agents too, using only currently visible people.
        // Stagger checks over a two-second interval and keep one snapshot for
        // search, route comparison, and shortcut selection within this tick.
        let mut occupants = vec![Vec::new(); agents.len()];
        // Visibility is symmetric. Check each pair once, retaining agent order
        // in each list so congestion sums remain deterministic.
        for i in 0..agents.len() {
            if evacuated[i] {
                continue;
            }
            for j in i + 1..agents.len() {
                if !evacuated[j]
                    && math::distance_to_point(before[i], before[j])
                        <= scenario.awareness.sight_range_metres
                    && geometry.has_line_of_sight(before[i], before[j])
                {
                    occupants[i].push((j, before[j]));
                    occupants[j].push((i, before[i]));
                }
            }
        }
        let forecasts: Vec<_> = (0..agents.len())
            .map(|i| {
                if evacuated[i] {
                    return congestion::CrowdForecast::default();
                }
                let map = beliefs.geometry_for_agent(&agents[i]);
                crowd_memory[i].observe(&occupants[i], step, scenario.time_step_seconds, map)
            })
            .collect();
        for i in 0..agents.len() {
            if evacuated[i] || windows.controls(i) {
                continue;
            }
            let map = beliefs.geometry_for_agent(&agents[i]);
            let lost_sight = routes[i]
                .as_ref()
                .is_some_and(|route| !map.can_move(before[i], route.waypoints[next_waypoint[i]]));
            let stalled =
                stalled_ticks[i] >= retry_ticks && stalled_ticks[i].is_multiple_of(retry_ticks);
            let periodic = (u64::from(step) + i as u64).is_multiple_of(u64::from(retry_ticks));
            if !lost_sight && !stalled && !periodic {
                continue;
            }
            let current_cost = routes[i].as_ref().map(|route| {
                navigation::route_cost(
                    before[i],
                    &route.waypoints[next_waypoint[i]..],
                    &forecasts[i],
                    scenario.agent_radius,
                )
            });
            let (map, navigation) = beliefs.for_agent(&agents[i]);
            let candidate = if windows.has_eligible() {
                navigation.find_safe_route_with_forecast(
                    before[i],
                    map,
                    &forecasts[i],
                    scenario.agent_radius,
                )
            } else {
                navigation.find_route_with_forecast(
                    before[i],
                    map,
                    &forecasts[i],
                    scenario.agent_radius,
                )
            };
            if let Some(route) = candidate {
                let cost = navigation::route_cost(
                    before[i],
                    &route.waypoints,
                    &forecasts[i],
                    scenario.agent_radius,
                );
                let accept = if lost_sight || routes[i].is_none() {
                    commitments[i].forced(now);
                    true
                } else {
                    let current = routes[i].as_ref().unwrap();
                    commitments[i].consider(
                        now,
                        before[i],
                        congestion::RouteEstimate {
                            exit_id: &current.exit_id,
                            waypoints: &current.waypoints[next_waypoint[i]..],
                            cost: current_cost.unwrap(),
                        },
                        congestion::RouteEstimate {
                            exit_id: &route.exit_id,
                            waypoints: &route.waypoints,
                            cost,
                        },
                        scenario.agent_radius,
                    )
                };
                if accept {
                    routes[i] = Some(route);
                    next_waypoint[i] = 0;
                    statistics[i].route_found = true;
                }
            }
        }
        // Priority is local to overlapping arrival lanes. A narrow opening
        // still needs yielding, while separated lanes can arrive together.
        // Use belief geometry here so unseen closures do not change guidance.
        let arrival_targets: Vec<_> = routes
            .iter()
            .enumerate()
            .map(|(i, route)| {
                if evacuated[i] || windows.controls(i) {
                    return None;
                }
                let route = route.as_ref()?;
                let map = beliefs.geometry_for_agent(&agents[i]);
                let (start, end) = map.exit_segment(&route.exit_id)?;
                let projected = math::closest_point_on_segment(before[i], start, end);
                let target = if map.can_move(before[i], projected) {
                    projected
                } else {
                    *route.waypoints.last()?
                };
                Some(target)
            })
            .collect();
        let arrival_exit_ids: Vec<_> = routes
            .iter()
            .map(|route| route.as_ref().map(|route| route.exit_id.clone()))
            .collect();
        let same_lane = |i: usize, j: usize| {
            arrival_exit_ids[i].is_some()
                && arrival_exit_ids[i] == arrival_exit_ids[j]
                && arrival_targets[i]
                    .zip(arrival_targets[j])
                    .is_some_and(|(a, b)| {
                        math::distance_to_point(a, b) < 2.0 * scenario.agent_radius + 1e-4
                    })
        };
        let arrival_priority: Vec<_> = (0..agents.len())
            .map(|i| {
                let Some(target) = arrival_targets[i] else {
                    return false;
                };
                let distance = math::distance_to_point(before[i], target);
                !(0..agents.len()).any(|j| {
                    if i == j || !same_lane(i, j) {
                        return false;
                    }
                    let other = math::distance_to_point(before[j], arrival_targets[j].unwrap());
                    other < distance || (other == distance && agents[j].id < agents[i].id)
                })
            })
            .collect();
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
            if windows.controls(i) {
                targets[i] = windows.target(i, before[i], &geometry);
                velocity_limits[i] = windows
                    .geometry(i, &geometry)
                    .velocity_limits(before[i], scenario.time_step_seconds);
                velocity_limits[i].extend(windows.approach_limits(
                    i,
                    before[i],
                    scenario.time_step_seconds,
                ));
                if agents[i].injury > 0.0 {
                    velocity_limits[i].extend(motion::injury_speed_limits(agents[i].injury));
                }
                continue;
            }
            let Some(route) = &mut routes[i] else {
                continue;
            };
            let map = beliefs.geometry_for_agent(&agents[i]);
            // Let lateral avoidance choose a different arrival position rather
            // than steering everybody back to an earlier fixed point.
            if next_waypoint[i] + 1 == route.waypoints.len()
                && let Some((start, end)) = map.exit_segment(&route.exit_id)
            {
                let target = math::closest_point_on_segment(before[i], start, end);
                let last = route.waypoints.last_mut().unwrap();
                if map.can_move(before[i], target)
                    && map.avoids_known_danger(before[i], target)
                    && navigation::route_cost(
                        before[i],
                        &[target],
                        &forecasts[i],
                        scenario.agent_radius,
                    ) <= navigation::route_cost(
                        before[i],
                        &[*last],
                        &forecasts[i],
                        scenario.agent_radius,
                    ) + math::EPSILON
                {
                    *last = target;
                }
            }
            for future in (next_waypoint[i] + 1..route.waypoints.len()).rev() {
                let shortcut = [route.waypoints[future]];
                if map.can_move(before[i], shortcut[0])
                    && map.avoids_known_danger(before[i], shortcut[0])
                    && navigation::route_cost(
                        before[i],
                        &shortcut,
                        &forecasts[i],
                        scenario.agent_radius,
                    ) <= navigation::route_cost(
                        before[i],
                        &route.waypoints[next_waypoint[i]..=future],
                        &forecasts[i],
                        scenario.agent_radius,
                    ) + math::EPSILON
                {
                    next_waypoint[i] = future;
                    break;
                }
            }
            let waypoint = route.waypoints[next_waypoint[i]];
            targets[i] = Some(waypoint);
            velocity_limits[i] = geometry.velocity_limits(before[i], scenario.time_step_seconds);
            if agents[i].injury > 0.0 {
                velocity_limits[i].extend(motion::injury_speed_limits(agents[i].injury));
            }
            if geometry.can_move(before[i], *route.waypoints.last().unwrap()) {
                velocity_limits[i].extend(geometry.exit_approach_limits(
                    before[i],
                    &route.exit_id,
                    scenario.time_step_seconds,
                    if arrival_priority[i] {
                        0.0
                    } else {
                        2.0 * scenario.agent_radius + 1e-4
                    },
                ));
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
            if windows.controls(i) {
                let neighbors = previous_neighbors(i);
                let budget =
                    windows.movement_budget(i, movement_budget * (1.0 - 0.75 * agents[i].injury));
                let candidate = if windows.traversing(i)
                    || (windows.has_priority(i)
                        && math::distance_to_point(before[i], waypoint)
                            <= 2.0 * scenario.agent_radius + movement_budget
                        && geometry.can_move(before[i], waypoint))
                {
                    // Climbing follows the real checked side-to-side segment;
                    // pedestrian acceleration cannot carry it past the landing.
                    math::move_toward(before[i], waypoint, budget)
                } else {
                    motion[i].propose(
                        before[i],
                        intents[i],
                        scenario.time_step_seconds,
                        scenario.agent_radius,
                        &neighbors,
                        velocity_limits[i].clone(),
                    )
                };
                let candidate = if math::distance_to_point(before[i], candidate) > budget {
                    math::move_toward(before[i], candidate, budget)
                } else {
                    candidate
                };
                // Approach snapping is also a swept-disc check; no pane crossing
                // is available until this occupant owns the service slot.
                let candidate = if math::distance_to_point(before[i], waypoint) <= budget
                    && windows.geometry(i, &geometry).can_move(before[i], waypoint)
                {
                    waypoint
                } else {
                    candidate
                };
                if windows
                    .geometry(i, &geometry)
                    .can_move(before[i], candidate)
                {
                    proposed[i] = candidate;
                }
                continue;
            }
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
                    } else if same_lane(i, j) && arrival_priority[i] {
                        0.05
                    } else if same_lane(i, j) && arrival_priority[j] {
                        0.95
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
            if arrival_priority[i]
                && next_waypoint[i] + 1 == route.waypoints.len()
                && math::distance_to_point(before[i], exit)
                    <= 2.0 * scenario.agent_radius + movement_budget
                && geometry.can_move(before[i], exit)
            {
                let speed = (previous_velocities[i].x.hypot(previous_velocities[i].y)
                    + motion::ACCELERATION * scenario.time_step_seconds)
                    .min(motion::WALKING_SPEED * (1.0 - 0.75 * agents[i].injury));
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
                } else if windows.controls(i) {
                    if windows.traversing(i) { 0.0 } else { 1.0 }
                } else if arrival_priority[i] {
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
            if !windows
                .geometry(i, &geometry)
                .can_move(before[i], proposed[i])
            {
                proposed[i] = before[i];
            }
            if windows.controls(i) {
                let budget =
                    windows.movement_budget(i, movement_budget * (1.0 - 0.75 * agents[i].injury));
                if math::distance_to_point(before[i], proposed[i]) > budget + 1e-8 {
                    proposed[i] = math::move_toward(before[i], proposed[i], budget);
                    if !windows
                        .geometry(i, &geometry)
                        .can_move(before[i], proposed[i])
                    {
                        proposed[i] = before[i];
                    }
                }
            }
        }
        motion::resolve_collisions(&before, &mut proposed, &active, scenario.agent_radius);
        #[cfg(test)]
        tests::assert_accepted_moves(scenario, &geometry, &before, &proposed, &active, &windows);
        let previous_hazard = world.prepare_hazards(step + 1);
        let mut leaving = Vec::new();
        let mut progress = false;
        for i in 0..agents.len() {
            if evacuated[i] {
                continue;
            }
            catastrophe::expose_between(
                &mut agents[i],
                before[i],
                proposed[i],
                scenario,
                previous_hazard.as_ref(),
                world.disaster_state(),
            );
            statistics[i].injury = agents[i].injury;
            statistics[i].exposure_seconds = agents[i].exposure_seconds;
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
            if windows.controls(i) {
                continue;
            }
            let route = routes[i].as_ref().unwrap();
            if (tornado && catastrophe::shelter_at(scenario, proposed[i]).is_some())
                || (!tornado && geometry.at_exit(proposed[i], &route.exit_id))
            {
                leaving.push(i);
                progress = true;
            } else if math::distance_to_point(proposed[i], waypoint) <= math::EPSILON {
                next_waypoint[i] += 1;
                // A believed opening may be physically closed. Retry discovery
                // rather than advancing beyond the final route waypoint.
                next_waypoint[i] = next_waypoint[i].min(route.waypoints.len() - 1);
                progress = true;
            }
        }

        step += 1;
        // Include exit arrivals in traffic before removing evacuated agents.
        record_traffic(scenario, &agents, &evacuated, &mut traffic);
        for i in leaving {
            evacuated[i] = true;
            if tornado {
                sheltered_count += 1;
                agents[i].sheltered = true;
                statistics[i].shelter = Some(crate::models::ShelterArrival {
                    id: catastrophe::shelter_at(scenario, agents[i].position)
                        .unwrap()
                        .into(),
                    step,
                    seconds: f64::from(step) * scenario.time_step_seconds,
                });
            } else {
                evacuated_count += 1;
                statistics[i].evacuation_step = Some(step);
                statistics[i].evacuation_seconds =
                    Some(f64::from(step) * scenario.time_step_seconds);
                statistics[i].exit_id = routes[i].as_ref().map(|route| route.exit_id.clone());
                if !scenario.windows.is_empty() {
                    statistics[i].escape_route =
                        statistics[i]
                            .exit_id
                            .as_ref()
                            .map(|id| crate::models::EscapeRoute {
                                kind: crate::models::EscapeRouteKind::NormalExit,
                                opening_id: id.clone(),
                            });
                }
            }
        }
        for (i, id) in windows.finish(step, &agents) {
            evacuated[i] = true;
            evacuated_count += 1;
            window_escapes += 1;
            statistics[i].evacuation_step = Some(step);
            statistics[i].evacuation_seconds = Some(f64::from(step) * scenario.time_step_seconds);
            statistics[i].exit_id = None;
            statistics[i].escape_route = Some(crate::models::EscapeRoute {
                kind: crate::models::EscapeRouteKind::EmergencyWindow,
                opening_id: id,
            });
            progress = true;
        }
        if world.apply(step, &agents, &evacuated) {
            geometry =
                geometry::Geometry::with_blocked_openings(scenario, emergencies, world.blocked());
            geometry.hazard_areas = world
                .disaster_state()
                .map_or_else(Vec::new, |state| state.areas.clone());
            windows.refresh(emergencies, world.blocked(), &geometry);
        }
        let previously_all_blocked = all_exits_blocked;
        all_exits_blocked = scenario.exits.iter().all(|e| world.states[&e.id].blocked);
        if all_exits_blocked || previously_all_blocked != all_exits_blocked {
            window_fallback.fill(all_exits_blocked);
        }
        // State changes at this timestamp are recorded in both live and saved
        // frames; preparation deadlines are never shifted by rendering stride.
        windows.update(step, &agents, &evacuated, &window_fallback, &geometry);
        for (i, statistic) in statistics.iter_mut().enumerate() {
            if windows.controls(i) {
                statistic.route_found = true;
            }
        }
        if step.is_multiple_of(frame_stride) {
            frames.push(frame(step, &agents, &evacuated, &world, &windows));
        }
        if step.is_multiple_of(live_stride)
            && let Some(emit) = &mut on_frame
        {
            if !emit(&frame(step, &agents, &evacuated, &world, &windows)) {
                return Err(SimulationError::Cancelled);
            }
            last_live_step = step;
        }
        idle_steps =
            if progress || information_changed || world.has_pending_changes() || windows.has_work()
            {
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
        frames.push(frame(step, &agents, &evacuated, &world, &windows));
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
    let remaining = total_population - evacuated_count - sheltered_count;
    for agent in &mut statistics {
        agent.elapsed_seconds = f64::from(
            agent
                .evacuation_step
                .or_else(|| agent.shelter.as_ref().map(|s| s.step))
                .unwrap_or(step),
        ) * scenario.time_step_seconds;
        agent.waiting_seconds = f64::from(agent.waiting_steps) * scenario.time_step_seconds;
    }
    let analytics = analytics::summarize(statistics, f64::from(step) * scenario.time_step_seconds);
    Ok(SimulationResult {
        metrics: SimulationMetrics {
            sheltered: sheltered_count,
            status,
            total_population,
            evacuated: evacuated_count,
            trapped: if no_available_exits && !windows.has_eligible() && !tornado {
                remaining
            } else {
                0
            },
            remaining,
            clearance_steps: (status == SimulationStatus::Completed).then_some(step),
            evacuated_by_route: (!scenario.windows.is_empty()).then_some(
                crate::models::EvacuatedByRoute {
                    normal_exit: evacuated_count - window_escapes,
                    emergency_window: window_escapes,
                },
            ),
        },
        frames,
        traffic_samples: traffic.into_values().collect(),
        width: scenario.width,
        height: scenario.height,
        time_step_seconds: scenario.time_step_seconds,
        analytics: Some(analytics),
        communication_events: Some(communication_events),
    })
}

fn frame(
    step: u32,
    agents: &[Agent],
    evacuated: &[bool],
    world: &awareness::OpeningStates,
    windows: &windows::Windows<'_>,
) -> AnimationFrame {
    AnimationFrame {
        window_states: windows.snapshots(agents),
        disaster_state: world.disaster_state().cloned(),
        sheltered: {
            let count = agents.iter().filter(|agent| agent.sheltered).count() as u32;
            (count > 0).then_some(count)
        },
        blocked_opening_ids: Some(world.blocked().into_iter().collect()),
        step,
        agents: agents
            .iter()
            .zip(evacuated)
            .filter(|(_, gone)| !**gone)
            .map(|(agent, _)| AgentPosition {
                injury: (agent.injury > 0.0).then_some(agent.injury),
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
