use self::agent::Agent;
use crate::models::{
    AgentPosition, AgentStatistics, AnimationFrame, BuildingScenario, Point, SimulationMetrics,
    SimulationResult, SimulationStatus, TrafficSample,
};
use std::{collections::BTreeMap, fmt};
mod agent;
mod analytics;
mod emergency;
mod geometry;
mod math;
mod navigation;
pub use emergency::Emergency;

#[derive(Debug)]
pub enum SimulationError {
    InvalidScenario(String),
    NotImplemented,
}

impl fmt::Display for SimulationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidScenario(message) => write!(f, "{message}"),
            Self::NotImplemented => write!(f, "simulation engine is not implemented"),
        }
    }
}

impl std::error::Error for SimulationError {}

/// Simplified waypoint-following model. Agents walk at 1.3 m/s and evacuate
/// upon reaching an available exit's centre; this does not certify outdoors.
pub fn simulate(scenario: &BuildingScenario) -> Result<SimulationResult, SimulationError> {
    simulate_with_emergencies(scenario, &[])
}

/// Emergencies are static for this run. Moving/spreading hazards will require
/// rebuilding navigation and rerouting agents when the hazard state changes.
/// The existing API entry point remains compatible and runs without hazards.
pub fn simulate_with_emergencies(
    scenario: &BuildingScenario,
    emergencies: &[Emergency],
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
    let geometry = geometry::Geometry::with_emergencies(scenario, emergencies);
    agent::spawn_agents(&mut agents, scenario, &geometry)?;

    let navigation = navigation::Navigation::new(scenario, &geometry);
    let routes: Vec<_> = agents
        .iter()
        .map(|agent| navigation.find_route(agent.position, &geometry))
        .collect();
    let mut next_waypoint = vec![0; agents.len()];
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
    let movement_budget = 1.3 * scenario.time_step_seconds;

    // Bound animation output by sampling ticks, retaining initial/final frames.
    // Physics and traffic still update every tick.
    let frame_stride = ((u64::from(total_population) * (u64::from(scenario.max_steps) + 1))
        .div_ceil(200_000))
    .max(1) as u32;
    let mut frames = vec![frame(0, &agents, &evacuated)];
    let mut traffic = BTreeMap::new();
    record_traffic(scenario, &agents, &evacuated, &mut traffic);

    let status = loop {
        if evacuated_count == total_population {
            break SimulationStatus::Completed;
        }
        if !routes
            .iter()
            .enumerate()
            .any(|(i, route)| !evacuated[i] && route.is_some())
        {
            break SimulationStatus::Incomplete;
        }
        if step == scenario.max_steps {
            break SimulationStatus::Timeout;
        }

        let before: Vec<Point> = agents.iter().map(|agent| agent.position).collect();
        let mut processed = vec![false; agents.len()];
        let mut leaving = Vec::new();
        let mut progress = false;

        // Rotate priority deterministically so the same person is not always first.
        for offset in 0..agents.len() {
            let i = (step as usize + offset) % agents.len();
            if evacuated[i] {
                continue;
            }
            let Some(route) = &routes[i] else { continue };
            let waypoint = route.waypoints[next_waypoint[i]];
            let proposed = math::move_toward(before[i], waypoint, movement_budget);
            if !geometry.can_move(before[i], proposed) {
                statistics[i].waiting_steps += 1;
                continue;
            }

            // Accepted agents follow their swept path. Unprocessed agents are
            // conservatively treated as stationary for this tick. This prevents
            // both overlap and agents crossing through each other between frames.
            let blocked = (0..agents.len()).any(|j| {
                if i == j || evacuated[j] {
                    return false;
                }
                let other_end = if processed[j] {
                    agents[j].position
                } else {
                    before[j]
                };
                math::moving_circles_overlap(
                    before[i],
                    proposed,
                    scenario.agent_radius,
                    before[j],
                    other_end,
                    scenario.agent_radius,
                )
            });
            if blocked {
                statistics[i].waiting_steps += 1;
                continue;
            }

            agents[i].position = proposed;
            statistics[i].distance_metres += math::distance_to_point(before[i], proposed);
            processed[i] = true;
            progress |= math::distance_to_point(before[i], proposed) > 0.0;
            if math::distance_to_point(proposed, waypoint) <= math::EPSILON {
                next_waypoint[i] += 1;
                progress = true;
                if next_waypoint[i] == route.waypoints.len() {
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
        if step % frame_stride == 0 {
            frames.push(frame(step, &agents, &evacuated));
        }
        idle_steps = if progress { 0 } else { idle_steps + 1 };
        // A full priority cycle without any movement is a stalled run, not a
        // claim that these remaining occupants are geometrically unreachable.
        if idle_steps >= agents.len().max(1) {
            break SimulationStatus::Incomplete;
        }
    };

    if frames.last().is_none_or(|last| last.step != step) {
        frames.push(frame(step, &agents, &evacuated));
    }
    // Graph-search failure alone is not proof of entrapment. We only classify
    // trapped occupants when every exit is explicitly disabled.
    let no_available_exits = scenario
        .exits
        .iter()
        .all(|exit| scenario.blocked_exit_ids.contains(&exit.id));
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

fn frame(step: u32, agents: &[Agent], evacuated: &[bool]) -> AnimationFrame {
    AnimationFrame {
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
