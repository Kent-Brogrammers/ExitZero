use self::agent::Agent;
use crate::models::{
    AgentEvent, AgentPlannedPath, AgentPosition, AgentStatistics, AnimationFrame, BuildingScenario,
    CommunicationEvent, Point, SimulationMetrics, SimulationResult, SimulationStatus,
    TrafficSample,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};
mod agent;
mod analytics;
mod architecture;
mod awareness;
mod catastrophe;
mod congestion;
pub(crate) mod control;
mod dialogue;
mod discovery;
pub use control::{ComputationControl, ComputationProgress};
mod emergency;
mod evolution;
mod geometry;
mod heatmap;
mod math;
mod modifiers;
mod motion;
mod navigation;
mod perception;
mod pursuit;
mod pursuit_awareness;
mod windows;
pub use emergency::Emergency;

const STAGNATION_SECONDS: f64 = 15.0;
const MEANINGFUL_MOVEMENT_METRES: f64 = 0.1;

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
    run(scenario, emergencies, None, None, None)
}

/// Observe actual physics frames before completion. Returning false cancels the
/// run, allowing a disconnected live viewer to release the simulation worker.
pub fn simulate_live(
    scenario: &BuildingScenario,
    on_frame: &mut dyn FnMut(&AnimationFrame) -> bool,
) -> Result<SimulationResult, SimulationError> {
    run(scenario, &[], Some(on_frame), None, None)
}

type ChatObserver<'a> = dyn FnMut(&[CommunicationEvent], &[AgentEvent]) -> bool + 'a;

/// Send newly recorded messages after the corresponding live physics frame.
/// Returning false from either observer cancels the run.
pub fn simulate_live_with_chat(
    scenario: &BuildingScenario,
    on_frame: &mut dyn FnMut(&AnimationFrame) -> bool,
    on_chat: &mut ChatObserver<'_>,
) -> Result<SimulationResult, SimulationError> {
    run(scenario, &[], Some(on_frame), Some(on_chat), None)
}

/// Report the actual immutable spawn assignments once, before the first live frame.
pub fn simulate_live_with_initialization(
    scenario: &BuildingScenario,
    on_frame: &mut dyn FnMut(&AnimationFrame) -> bool,
    on_chat: &mut ChatObserver<'_>,
    on_initialized: &mut dyn FnMut(&crate::models::AgentModifierRecording) -> bool,
) -> Result<SimulationResult, SimulationError> {
    run(
        scenario,
        &[],
        Some(on_frame),
        Some(on_chat),
        Some(on_initialized),
    )
}

type InitializationObserver<'a> = dyn FnMut(&crate::models::AgentModifierRecording) -> bool + 'a;

fn run(
    scenario: &BuildingScenario,
    emergencies: &[Emergency],
    mut on_frame: Option<&mut dyn FnMut(&AnimationFrame) -> bool>,
    mut on_chat: Option<&mut ChatObserver<'_>>,
    mut on_initialized: Option<&mut InitializationObserver<'_>>,
) -> Result<SimulationResult, SimulationError> {
    control::checkpoint()?;
    control::step(0, scenario.max_steps);
    scenario
        .validate()
        .map_err(SimulationError::InvalidScenario)?;
    let ready = scenario.with_window_escape_defaults();
    let scenario = ready.as_ref();
    if scenario.pursuit.is_some() {
        if !emergencies.is_empty() {
            return Err(SimulationError::InvalidScenario(
                "Pursuit cannot be combined with extra emergencies".into(),
            ));
        }
        return pursuit::run(scenario, on_frame);
    }

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
    for a in &mut agents {
        a.curious_waiting = (scenario.disaster.is_some() || !emergencies.is_empty())
            && a.modifiers.modifier_ids.iter().any(|id| {
                scenario
                    .agent_modifiers
                    .iter()
                    .any(|m| &m.id == id && m.requires_emergency_discovery)
            });
    }
    let mut curious_paths: Vec<Option<navigation::Route>> =
        (0..agents.len()).map(|_| None).collect();
    let mut curious_visited = vec![Vec::new(); agents.len()];

    if let Some(emit) = &mut on_initialized
        && !emit(&modifiers::recording(scenario, &agents))
    {
        return Err(SimulationError::Cancelled);
    }

    let mut beliefs = awareness::BeliefMaps::new(scenario, emergencies);
    for agent in &mut agents {
        agent.known_walls.clone_from(&beliefs.architecture.exterior);
    }
    let mut routes: Vec<_> = agents
        .iter()
        .map(|agent| {
            control::checkpoint()?;
            let (map, navigation) = beliefs.for_agent(agent);
            let forecast =
                congestion::CrowdForecast::for_geometry(map).with_discovery(scenario, agent, map);
            Ok(navigation.find_route_with_forecast(
                agent.position,
                map,
                &forecast,
                scenario.agent_radius,
            ))
        })
        .collect::<Result<Vec<_>, SimulationError>>()?;
    let mut next_waypoint = vec![0; agents.len()];
    let mut escape_routes: Vec<Option<Vec<Point>>> = vec![None; agents.len()];
    let mut next_escape_waypoint = vec![0; agents.len()];
    let mut last_escape_attempt = vec![None; agents.len()];
    let mut motion: Vec<_> = agents.iter().map(|_| motion::Motion::new()).collect();
    let retry_ticks = (2.0 / scenario.time_step_seconds).ceil() as u32;
    let mut stalled_ticks = vec![0_u32; agents.len()];
    let mut last_progress_step = vec![0_u32; agents.len()];
    let mut stalled_exits = vec![BTreeSet::new(); agents.len()];
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
    let mut shelter_admissions = BTreeMap::new();
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
    let mut movement_anchors: Vec<_> = agents.iter().map(|agent| agent.position).collect();
    let mut last_movement_step = 0;
    let mut last_resolved_population = 0;
    let mut communication_events = Vec::new();
    let mut dialogue = dialogue::Dialogue::new(agents.len());
    let modified_run = agents.iter().any(Agent::modified);

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
    let exit_seconds = expected_exit_seconds(
        scenario,
        &agents,
        &evacuated,
        &routes,
        &next_waypoint,
        &mut beliefs,
    );
    windows.choose(0, &agents, &evacuated, &exit_seconds, &geometry);
    let mut window_escapes = 0;
    let mut heatmap = heatmap::Heatmap::default();
    let initial_plans = PlannedPaths {
        routes: &routes,
        cursors: &next_waypoint,
        escapes: &escape_routes,
        escape_cursors: &next_escape_waypoint,
    };
    let mut initial_frame = frame(
        0,
        &agents,
        &evacuated,
        &world,
        &windows,
        &initial_plans,
        &geometry,
    );
    initial_frame.congestion_samples = heatmap.saved();
    let mut frames = vec![initial_frame];
    let live_stride = (0.05 / scenario.time_step_seconds).ceil().max(1.0) as u32;
    let mut last_live_step = 0;
    let mut sent_communications = 0;
    let mut sent_activity = 0;
    let mut emit_chat = |communications: &[CommunicationEvent], activity: &[AgentEvent]| {
        if let Some(emit) = &mut on_chat
            && (communications.len() > sent_communications || activity.len() > sent_activity)
        {
            if !emit(
                &communications[sent_communications..],
                &activity[sent_activity..],
            ) {
                return false;
            }
            sent_communications = communications.len();
            sent_activity = activity.len();
        }
        true
    };
    if let Some(emit) = &mut on_frame
        && !emit(&frames[0])
    {
        return Err(SimulationError::Cancelled);
    }
    let mut traffic = BTreeMap::new();
    record_traffic(scenario, &agents, &evacuated, &mut traffic);

    use crate::models::TerminationReason;
    let (status, termination_reason) = loop {
        control::checkpoint()?;
        control::step(step, scenario.max_steps);
        if evacuated_count + sheltered_count == total_population {
            break (SimulationStatus::Completed, TerminationReason::Completed);
        }
        // Admission counts, rather than route availability or movement, decide
        // when shelter capacity is exhausted. Completion takes precedence above.
        if tornado
            && !scenario.tornado_zones.is_empty()
            && scenario.tornado_zones.iter().all(|zone| {
                shelter_admissions.get(&zone.id).copied().unwrap_or(0) >= zone.capacity()
            })
        {
            break (
                SimulationStatus::Incomplete,
                TerminationReason::AllSheltersFull,
            );
        }
        let now = f64::from(step) * scenario.time_step_seconds;
        let (mut changed_beliefs, information_changed) = awareness::update_knowledge(
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
            if agents[i].curious_waiting && agents[i].saw_emergency {
                agents[i].curious_waiting = false;
                routes[i] = None;
                changed_beliefs[i] = true;
                windows.cancel(i);
            }
        }
        for i in 0..agents.len() {
            control::checkpoint()?;
            let versions: Vec<_> = agents[i]
                .known_hazards
                .values()
                .map(|area| (area.id, area.revision))
                .collect();
            let changed_disaster = versions != routed_disaster[i];
            let shelter_full = !evacuated[i]
                && routes[i].as_ref().is_some_and(|route| {
                    tornado
                        && beliefs
                            .geometry_for_agent(&agents[i])
                            .full_shelters
                            .contains(&route.exit_id)
                });
            if evacuated[i] || (!changed_beliefs[i] && !changed_disaster && !shelter_full) {
                continue;
            }
            let map = beliefs.geometry_for_agent(&agents[i]);
            let mut from = agents[i].position;
            let valid = routes[i].as_ref().is_some_and(|route| {
                !shelter_full
                    && !map.opening_is_unsafe(&route.exit_id)
                    && route.waypoints[next_waypoint[i]..].iter().all(|&to| {
                        let clear = map.can_move(from, to)
                            && (scenario
                                .disaster
                                .is_none_or(|d| d.kind != crate::models::DisasterKind::Fire)
                                || map.avoids_known_danger(from, to));
                        from = to;
                        clear
                    })
            });
            if valid && (!changed_disaster || now - last_disaster_replan[i] < 0.5) {
                continue;
            }
            let forecast = congestion::CrowdForecast::for_geometry(map)
                .with_discovery(scenario, &agents[i], map);
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
            let candidate = if windows.can_consider() {
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
        // A window approach leaves the old exit waypoints behind. Compare against
        // a fresh safe exit route from the current position, using personal knowledge.
        let comparison_ticks = (0.5 / scenario.time_step_seconds).ceil().max(1.0) as u32;
        if step.is_multiple_of(comparison_ticks) {
            for i in 0..agents.len() {
                if evacuated[i] || !windows.controls(i) {
                    continue;
                }
                let (map, navigation) = beliefs.for_agent(&agents[i]);
                let forecast = congestion::CrowdForecast::for_geometry(map)
                    .with_discovery(scenario, &agents[i], map);
                routes[i] = navigation.find_safe_route_with_forecast(
                    agents[i].position,
                    map,
                    &forecast,
                    scenario.agent_radius,
                );
                next_waypoint[i] = 0;
            }
        }
        let exit_seconds = expected_exit_seconds(
            scenario,
            &agents,
            &evacuated,
            &routes,
            &next_waypoint,
            &mut beliefs,
        );
        let window_fallback: Vec<_> = exit_seconds.iter().map(|s| !s.is_finite()).collect();
        let controlled: Vec<_> = (0..agents.len()).map(|i| windows.controls(i)).collect();
        windows.choose(step, &agents, &evacuated, &exit_seconds, &geometry);
        dialogue.observe(
            step,
            scenario,
            &agents,
            &routes,
            &statistics,
            windows.snapshots(&agents).as_deref(),
        );
        for i in 0..agents.len() {
            control::checkpoint()?;
            if windows.controls(i) {
                if windows.using_window(i) {
                    statistics[i].route_found = true;
                }
            } else if !evacuated[i]
                && (controlled[i] || (window_fallback[i] && routes[i].is_none()))
            {
                // If no window can actually take control, do not strand an
                // occupant simply because a hazardous normal exit is all that remains.
                let (map, navigation) = beliefs.for_agent(&agents[i]);
                let gas = scenario
                    .disaster
                    .is_some_and(|d| d.kind == crate::models::DisasterKind::GasLeak);
                let forecast = congestion::CrowdForecast::for_geometry(map)
                    .with_discovery(scenario, &agents[i], map);
                routes[i] = if windows.can_consider() && !gas {
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
            && !agents
                .iter()
                .enumerate()
                .any(|(i, a)| !evacuated[i] && (a.reacting(step) || a.curious_waiting))
            && !world.has_pending_changes()
            && !information_changed
            && scenario.disaster.is_none()
        {
            break (
                SimulationStatus::Incomplete,
                TerminationReason::NoActiveRoutes,
            );
        }
        if step == scenario.max_steps {
            break (SimulationStatus::Timeout, TerminationReason::StepLimit);
        }

        let movement_speeds: Vec<_> = agents
            .iter()
            .map(|a| if a.reacting(step) { 0.0 } else { a.speed() })
            .collect();
        let movement_budgets: Vec<_> = movement_speeds
            .iter()
            .map(|speed| speed * scenario.time_step_seconds)
            .collect();
        for (controller, agent) in motion.iter_mut().zip(&agents).filter(|_| modified_run) {
            controller.configure(
                if agent.reacting(step) {
                    0.0
                } else {
                    agent.speed()
                },
                motion::ACCELERATION * agent.modifiers.resolved.acceleration_multiplier,
            );
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
            control::checkpoint()?;
            if evacuated[i] {
                continue;
            }
            for j in i + 1..agents.len() {
                if !evacuated[j]
                    && scenario.awareness.visibility_range() > 0.0
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
                crowd_memory[i]
                    .observe(&occupants[i], step, scenario.time_step_seconds, map)
                    .with_discovery(scenario, &agents[i], map)
            })
            .collect();
        for i in 0..agents.len() {
            control::checkpoint()?;
            if evacuated[i] || windows.controls(i) {
                continue;
            }
            let map = beliefs.geometry_for_agent(&agents[i]);
            let lost_sight = routes[i]
                .as_ref()
                .is_some_and(|route| !map.can_move(before[i], route.waypoints[next_waypoint[i]]));
            let without_progress = step.saturating_sub(last_progress_step[i]);
            let stalled = (stalled_ticks[i] >= retry_ticks
                && stalled_ticks[i].is_multiple_of(retry_ticks))
                || (without_progress >= retry_ticks
                    && without_progress.is_multiple_of(retry_ticks));
            let reassessment_ticks = (f64::from(retry_ticks)
                * agents[i]
                    .modifiers
                    .resolved
                    .reassessment_interval_multiplier)
                .ceil()
                .max(1.0) as u32;
            let periodic =
                (u64::from(step) + i as u64).is_multiple_of(u64::from(reassessment_ticks));
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
            let alternative = if stalled && !tornado {
                if let Some(route) = &routes[i] {
                    stalled_exits[i].insert(route.exit_id.clone());
                }
                navigation.find_alternative_route(before[i], map, &forecasts[i], &stalled_exits[i])
            } else {
                None
            };
            if stalled && alternative.is_none() {
                stalled_exits[i].clear();
            }
            let candidate = alternative.or_else(|| {
                if windows.can_consider() {
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
                }
            });
            if let Some(route) = candidate {
                let cost = navigation::route_cost(
                    before[i],
                    &route.waypoints,
                    &forecasts[i],
                    scenario.agent_radius,
                );
                let accept = if stalled || lost_sight || routes[i].is_none() {
                    commitments[i].forced(now);
                    true
                } else {
                    let current = routes[i].as_ref().unwrap();
                    commitments[i].consider_with_threshold(
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
                        agents[i]
                            .modifiers
                            .resolved
                            .route_switch_threshold_multiplier,
                    )
                };
                if accept {
                    routes[i] = Some(route);
                    next_waypoint[i] = 0;
                    statistics[i].route_found = true;
                }
            }
        }
        // A person without a usable destination still tries to leave known
        // fire or gas. Keep these local waypoints separate from evacuation
        // routes so reaching clear floor never resolves an occupant.
        for i in 0..agents.len() {
            control::checkpoint()?;
            if evacuated[i] || tornado || windows.controls(i) || routes[i].is_some() {
                escape_routes[i] = None;
                continue;
            }
            let map = beliefs.geometry_for_agent(&agents[i]);
            if !map.is_in_known_danger(before[i]) {
                escape_routes[i] = None;
                continue;
            }
            let valid = escape_routes[i].as_ref().is_some_and(|waypoints| {
                !map.is_in_known_danger(*waypoints.last().unwrap())
                    && map.can_move(before[i], waypoints[next_escape_waypoint[i]])
            });
            if valid && stalled_ticks[i] < retry_ticks {
                continue;
            }
            escape_routes[i] = None;
            if last_escape_attempt[i].is_some_and(|last| step.saturating_sub(last) < retry_ticks) {
                continue;
            }
            let (map, navigation) = beliefs.for_agent(&agents[i]);
            escape_routes[i] = navigation.find_escape_route(before[i], map);
            next_escape_waypoint[i] = 0;
            last_escape_attempt[i] = Some(step);
            stalled_ticks[i] = 0;
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
                    other < distance
                        || (other == distance
                            && (agents[j].modifiers.resolved.avoidance_priority_multiplier
                                > agents[i].modifiers.resolved.avoidance_priority_multiplier
                                || (agents[j].modifiers.resolved.avoidance_priority_multiplier
                                    == agents[i].modifiers.resolved.avoidance_priority_multiplier
                                    && agents[j].id < agents[i].id)))
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
            control::checkpoint()?;
            if evacuated[i] || agents[i].reacting(step) {
                continue;
            }
            if agents[i].curious_waiting {
                windows.cancel(i);
                if curious_paths[i].as_ref().is_some_and(|r| {
                    r.waypoints.is_empty()
                        || math::distance_to_point(before[i], *r.waypoints.last().unwrap()) < 0.1
                }) {
                    curious_visited[i].push(before[i]);
                    curious_paths[i] = None;
                }
                if curious_paths[i].is_none() || stalled_ticks[i] >= retry_ticks {
                    let architecture = beliefs.architecture.clone();
                    let (map, navigation) = beliefs.for_agent(&agents[i]);
                    curious_paths[i] = discovery::search_route(
                        scenario,
                        &agents[i],
                        map,
                        navigation,
                        &curious_visited[i],
                        &architecture,
                    );
                    stalled_ticks[i] = 0;
                }
                if let Some(r) = &mut curious_paths[i] {
                    while r.waypoints.len() > 1
                        && math::distance_to_point(before[i], r.waypoints[0]) < 0.15
                    {
                        r.waypoints.remove(0);
                    }
                }
                routes[i] = curious_paths[i].clone();
                next_waypoint[i] = 0;
                if let Some(r) = &routes[i] {
                    let mut target = r.waypoints[0];
                    for &p in &r.waypoints {
                        if math::distance_to_point(before[i], p) > 0.1 {
                            target = p;
                            break;
                        }
                    }
                    targets[i] = Some(target);
                    velocity_limits[i] =
                        geometry.velocity_limits(before[i], scenario.time_step_seconds);
                }
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
                if !modified_run && agents[i].injury > 0.0 {
                    velocity_limits[i].extend(motion::injury_speed_limits(agents[i].injury));
                }
                continue;
            }
            let Some(route) = &mut routes[i] else {
                if let Some(waypoints) = &escape_routes[i] {
                    targets[i] = Some(waypoints[next_escape_waypoint[i]]);
                    velocity_limits[i] =
                        geometry.velocity_limits(before[i], scenario.time_step_seconds);
                    if !modified_run && agents[i].injury > 0.0 {
                        velocity_limits[i].extend(motion::injury_speed_limits(agents[i].injury));
                    }
                }
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
                    && (route.risk_allowed || map.avoids_known_danger(before[i], target))
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
                    && (route.risk_allowed || map.avoids_known_danger(before[i], shortcut[0]))
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
            if !modified_run && agents[i].injury > 0.0 {
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
                    responsibility: if !agents[j].reacting(step)
                        && (routes[j].is_some() || escape_routes[j].is_some())
                    {
                        agents[j].modifiers.resolved.avoidance_priority_multiplier
                            / (agents[i].modifiers.resolved.avoidance_priority_multiplier
                                + agents[j].modifiers.resolved.avoidance_priority_multiplier)
                    } else {
                        1.0
                    },
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
            control::checkpoint()?;
            let Some(waypoint) = targets[i] else {
                continue;
            };
            if windows.controls(i) {
                let neighbors = previous_neighbors(i);
                let budget = windows.movement_budget(i, movement_budgets[i]);
                let candidate = if windows.traversing(i)
                    || (windows.has_priority(i)
                        && math::distance_to_point(before[i], waypoint)
                            <= 2.0 * scenario.agent_radius + movement_budgets[i]
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
            let route = routes[i].as_ref();
            let exit = route.map_or(waypoint, |route| *route.waypoints.last().unwrap());
            let neighbors: Vec<_> = before
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i && !evacuated[*j])
                .map(|(j, &position)| motion::Neighbor {
                    position,
                    velocity: intents[j],
                    responsibility: if agents[j].reacting(step)
                        || (routes[j].is_none() && escape_routes[j].is_none())
                    {
                        1.0
                    } else if same_lane(i, j) && arrival_priority[i] {
                        0.05
                    } else if same_lane(i, j) && arrival_priority[j] {
                        0.95
                    } else if !windows.controls(j)
                        && math::distance_to_point(before[i], position)
                            < 4.0 * scenario.agent_radius
                        && targets[i].zip(targets[j]).is_some_and(|(a, b)| {
                            math::distance_to_point(a, b) < 2.0 * scenario.agent_radius
                        })
                    {
                        // Interior passages can serve agents heading to different exits.
                        // Break reciprocal symmetry near a shared waypoint as well.
                        if agents[i].modifiers.resolved.avoidance_priority_multiplier
                            > agents[j].modifiers.resolved.avoidance_priority_multiplier
                            || (agents[i].modifiers.resolved.avoidance_priority_multiplier
                                == agents[j].modifiers.resolved.avoidance_priority_multiplier
                                && agents[i].id < agents[j].id)
                        {
                            0.05
                        } else {
                            0.95
                        }
                    } else {
                        agents[j].modifiers.resolved.avoidance_priority_multiplier
                            / (agents[i].modifiers.resolved.avoidance_priority_multiplier
                                + agents[j].modifiers.resolved.avoidance_priority_multiplier)
                    },
                    horizon: if route.is_some_and(|route| {
                        routes[j]
                            .as_ref()
                            .is_some_and(|other| other.exit_id == route.exit_id)
                    }) {
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
            if !agents[i].curious_waiting
                && arrival_priority[i]
                && route.is_some_and(|route| next_waypoint[i] + 1 == route.waypoints.len())
                && math::distance_to_point(before[i], exit)
                    <= 2.0 * scenario.agent_radius + movement_budgets[i]
                && geometry.can_move(before[i], exit)
            {
                let speed = (previous_velocities[i].x.hypot(previous_velocities[i].y)
                    + motion::ACCELERATION
                        * agents[i].modifiers.resolved.acceleration_multiplier
                        * scenario.time_step_seconds)
                    .min(agents[i].speed());
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
                    ) <= movement_budgets[i] * 0.2
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
        let compliance: Vec<_> = compliance
            .iter()
            .enumerate()
            .map(|(i, value)| value / agents[i].modifiers.resolved.avoidance_priority_multiplier)
            .collect();
        motion::coordinate_moves_with_speeds(
            &before,
            &mut proposed,
            &active,
            &compliance,
            scenario.agent_radius,
            scenario.time_step_seconds,
            motion::MotionLimits {
                velocity: &velocity_limits,
                speeds: &movement_speeds,
            },
        );
        for i in 0..agents.len() {
            control::checkpoint()?;
            if modified_run && math::distance_to_point(before[i], proposed[i]) > movement_budgets[i]
            {
                proposed[i] = math::move_toward(before[i], proposed[i], movement_budgets[i]);
            }
            proposed[i].x = proposed[i].x.clamp(0.0, scenario.width);
            proposed[i].y = proposed[i].y.clamp(0.0, scenario.height);
            let enters_fire_core = !windows.traversing(i)
                && scenario
                    .disaster
                    .is_some_and(|d| d.kind == crate::models::DisasterKind::Fire)
                && !geometry.avoids_known_danger(before[i], proposed[i]);
            if enters_fire_core
                || !windows
                    .geometry(i, &geometry)
                    .can_move(before[i], proposed[i])
            {
                proposed[i] = before[i];
            }
            if windows.controls(i) {
                let budget = windows.movement_budget(i, movement_budgets[i]);
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
        for i in 0..agents.len() {
            control::checkpoint()?;
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
                < math::distance_to_point(before[i], waypoint) - movement_budgets[i] * 0.05
            {
                stalled_ticks[i] = 0;
            } else {
                stalled_ticks[i] += 1;
            }
            if agents[i].curious_waiting {
                continue;
            }
            if windows.controls(i) {
                if windows.searching(i)
                    && let Some(exit) = scenario
                        .exits
                        .iter()
                        .find(|exit| geometry.at_exit(proposed[i], &exit.id))
                {
                    windows.cancel(i);
                    routes[i] = Some(navigation::Route {
                        exit_id: exit.id.clone(),
                        risk_allowed: false,
                        waypoints: vec![proposed[i]],
                    });
                    next_waypoint[i] = 0;
                    statistics[i].route_found = true;
                    leaving.push(i);
                }
                continue;
            }
            let Some(route) = routes[i].as_ref() else {
                if math::distance_to_point(proposed[i], waypoint) <= math::EPSILON
                    && let Some(waypoints) = &escape_routes[i]
                {
                    next_escape_waypoint[i] =
                        (next_escape_waypoint[i] + 1).min(waypoints.len() - 1);
                }
                continue;
            };
            if (tornado
                && catastrophe::shelter_at(scenario, proposed[i], &shelter_admissions).is_some())
                || (!tornado && geometry.at_exit(proposed[i], &route.exit_id))
            {
                leaving.push(i);
            } else if math::distance_to_point(proposed[i], waypoint) <= math::EPSILON {
                next_waypoint[i] += 1;
                // A believed opening may be physically closed. Retry discovery
                // rather than advancing beyond the final route waypoint.
                next_waypoint[i] = next_waypoint[i].min(route.waypoints.len() - 1);
            }
        }

        let crowd_inactive: Vec<_> = (0..agents.len())
            .map(|i| {
                evacuated[i]
                    || (modified_run
                        && (agents[i].reacting(step)
                            || (windows.using_window(i)
                                && !windows.traversing(i)
                                && targets[i].is_some_and(|target| {
                                    math::distance_to_point(before[i], target) <= math::EPSILON
                                }))))
            })
            .collect();
        let reference_speeds: Vec<_> = agents
            .iter()
            .map(|a| {
                if modified_run {
                    a.speed()
                } else {
                    motion::WALKING_SPEED
                }
            })
            .collect();
        heatmap.record_with_speeds(
            scenario,
            &before,
            &agents,
            &crowd_inactive,
            &geometry,
            &reference_speeds,
        );
        step += 1;
        control::step(step, scenario.max_steps);
        // Include exit arrivals in traffic before removing evacuated agents.
        record_traffic(scenario, &agents, &evacuated, &mut traffic);
        for i in leaving {
            // Admit sequentially so simultaneous arrivals cannot exceed the limit.
            let shelter_id = if tornado {
                let Some(zone) =
                    catastrophe::shelter_at(scenario, agents[i].position, &shelter_admissions)
                else {
                    continue;
                };
                let admitted = shelter_admissions.entry(zone.id.clone()).or_insert(0);
                *admitted += 1;
                if *admitted == zone.capacity() {
                    beliefs.close_shelter(&zone.id);
                }
                Some(zone.id.clone())
            } else {
                None
            };
            evacuated[i] = true;
            if tornado {
                sheltered_count += 1;
                agents[i].sheltered = true;
                statistics[i].shelter = Some(crate::models::ShelterArrival {
                    id: shelter_id.unwrap(),
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
        }
        if world.apply(step, &agents, &evacuated) {
            geometry =
                geometry::Geometry::with_blocked_openings(scenario, emergencies, world.blocked());
            geometry.hazard_areas = world
                .disaster_state()
                .map_or_else(Vec::new, |state| state.areas.clone());
            windows.refresh(emergencies, world.blocked(), &geometry);
        }
        // State changes at this timestamp are recorded in both live and saved
        // frames; preparation deadlines are never shifted by rendering stride.
        let exit_seconds = expected_exit_seconds(
            scenario,
            &agents,
            &evacuated,
            &routes,
            &next_waypoint,
            &mut beliefs,
        );
        windows.choose(step, &agents, &evacuated, &exit_seconds, &geometry);
        dialogue.observe(
            step,
            scenario,
            &agents,
            &routes,
            &statistics,
            windows.snapshots(&agents).as_deref(),
        );
        for (i, statistic) in statistics.iter_mut().enumerate() {
            if windows.using_window(i) {
                statistic.route_found = true;
            }
        }
        let plans = PlannedPaths {
            routes: &routes,
            cursors: &next_waypoint,
            escapes: &escape_routes,
            escape_cursors: &next_escape_waypoint,
        };
        if step.is_multiple_of(frame_stride) {
            let mut saved = frame(
                step, &agents, &evacuated, &world, &windows, &plans, &geometry,
            );
            saved.congestion_samples = heatmap.saved();
            frames.push(saved);
        }
        if step.is_multiple_of(live_stride)
            && let Some(emit) = &mut on_frame
        {
            let mut live = frame(
                step, &agents, &evacuated, &world, &windows, &plans, &geometry,
            );
            live.congestion_samples = heatmap.live();
            if !emit(&live) {
                return Err(SimulationError::Cancelled);
            }
            if !emit_chat(&communication_events, &dialogue.events) {
                return Err(SimulationError::Cancelled);
            }
            last_live_step = step;
        }
        let mut meaningful_movement = false;
        for (i, agent) in agents.iter().enumerate() {
            if !evacuated[i]
                && math::distance_to_point(movement_anchors[i], agent.position)
                    >= if modified_run {
                        MEANINGFUL_MOVEMENT_METRES.min(agent.speed() * 0.1)
                    } else {
                        MEANINGFUL_MOVEMENT_METRES
                    }
            {
                meaningful_movement = true;
                movement_anchors[i] = agent.position;
                last_progress_step[i] = step;
                stalled_exits[i].clear();
            }
        }
        let resolved_population = evacuated_count + sheltered_count;
        if meaningful_movement
            || resolved_population != last_resolved_population
            || windows.has_timed_service(step)
        {
            last_movement_step = step;
        }
        last_resolved_population = resolved_population;
        // Lack of movement is not proof of entrapment while a route or window
        // approach remains available. Keep trying alternatives up to max_steps.
        let has_destination = windows.has_work()
            || routes
                .iter()
                .enumerate()
                .any(|(i, route)| !evacuated[i] && route.is_some())
            || escape_routes
                .iter()
                .enumerate()
                .any(|(i, route)| !evacuated[i] && route.is_some());
        if !has_destination
            && !agents
                .iter()
                .enumerate()
                .any(|(i, a)| !evacuated[i] && (a.reacting(step) || a.curious_waiting))
            && f64::from(step - last_movement_step) * scenario.time_step_seconds
                >= STAGNATION_SECONDS
        {
            break (
                SimulationStatus::Incomplete,
                TerminationReason::MovementStagnation,
            );
        }
    };

    let plans = PlannedPaths {
        routes: &routes,
        cursors: &next_waypoint,
        escapes: &escape_routes,
        escape_cursors: &next_escape_waypoint,
    };
    if frames.last().is_none_or(|last| last.step != step) {
        let mut saved = frame(
            step, &agents, &evacuated, &world, &windows, &plans, &geometry,
        );
        saved.congestion_samples = heatmap.saved();
        frames.push(saved);
    }
    if last_live_step != step
        && let Some(emit) = &mut on_frame
    {
        let mut live = frame(
            step, &agents, &evacuated, &world, &windows, &plans, &geometry,
        );
        live.congestion_samples = heatmap.live();
        if !emit(&live) {
            return Err(SimulationError::Cancelled);
        }
    }
    if !emit_chat(&communication_events, &dialogue.events) {
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
    let mut analytics =
        analytics::summarize(statistics, f64::from(step) * scenario.time_step_seconds);
    analytics.window_decisions = Some(windows.take_decisions());
    control::checkpoint()?;
    Ok(SimulationResult {
        agent_modifiers: Some(modifiers::recording(scenario, &agents)),
        congestion_samples: heatmap.total(),
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
        agent_events: Some(dialogue.events),
        termination_reason: Some(termination_reason),
    })
}

/// Evaluate the actual remaining belief-graph route, including unknown detours
/// and known danger. No reachability query against the physical world belongs here.
fn expected_exit_seconds(
    scenario: &BuildingScenario,
    agents: &[agent::Agent],
    evacuated: &[bool],
    routes: &[Option<navigation::Route>],
    cursors: &[usize],
    beliefs: &mut awareness::BeliefMaps<'_>,
) -> Vec<f64> {
    agents
        .iter()
        .enumerate()
        .map(|(i, agent)| {
            if evacuated[i] {
                return 0.0;
            }
            let Some(route) = &routes[i] else {
                return f64::INFINITY;
            };
            let map = beliefs.geometry_for_agent(agent);
            let mut from = agent.position;
            if map.opening_is_unsafe(&route.exit_id)
                || !route.waypoints[cursors[i]..].iter().all(|&to| {
                    let safe = map.can_move(from, to) && map.avoids_known_danger(from, to);
                    from = to;
                    safe
                })
            {
                return f64::INFINITY;
            }
            navigation::route_cost(
                agent.position,
                &route.waypoints[cursors[i]..],
                &congestion::CrowdForecast::default(),
                scenario.agent_radius,
            ) / agent.speed()
        })
        .collect()
}

struct PlannedPaths<'a> {
    routes: &'a [Option<navigation::Route>],
    cursors: &'a [usize],
    escapes: &'a [Option<Vec<Point>>],
    escape_cursors: &'a [usize],
}

impl PlannedPaths<'_> {
    fn for_agent(
        &self,
        i: usize,
        position: Point,
        windows: &windows::Windows<'_>,
        geometry: &geometry::Geometry<'_>,
    ) -> AgentPlannedPath {
        if let Some(path) = windows.planned_path(i, position, geometry) {
            path
        } else if let Some(route) = &self.routes[i] {
            AgentPlannedPath::snapshot(route.waypoints[self.cursors[i]..].iter().copied())
        } else if let Some(route) = &self.escapes[i] {
            AgentPlannedPath::snapshot(route[self.escape_cursors[i]..].iter().copied())
        } else {
            AgentPlannedPath::default()
        }
    }
}

fn frame(
    step: u32,
    agents: &[Agent],
    evacuated: &[bool],
    world: &awareness::OpeningStates,
    windows: &windows::Windows<'_>,
    plans: &PlannedPaths<'_>,
    geometry: &geometry::Geometry<'_>,
) -> AnimationFrame {
    AnimationFrame {
        congestion_samples: None,
        pursuit: None,
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
            .enumerate()
            .filter(|(_, (_, gone))| !**gone)
            .map(|(i, (agent, _))| AgentPosition {
                injury: (agent.injury > 0.0).then_some(agent.injury),
                planned_path: Some(plans.for_agent(i, agent.position, windows, geometry)),
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
