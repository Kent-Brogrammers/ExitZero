//! Observational dialogue only: recording must never change physics or beliefs.
use super::{agent::Agent, math, navigation::Route};
use crate::models::{
    AgentEvent, AgentEventKind as Kind, AgentStatistics, BuildingScenario, HazardArea,
    WindowFrameState, WindowState,
};
use std::collections::BTreeMap;

#[derive(Default)]
struct Last {
    goal: Option<String>,
    initialized: bool,
    window: Option<(String, Kind)>,
    hazard: Option<(HazardArea, u32)>,
    exposed: bool,
    waited: bool,
    done: bool,
}

pub(super) struct Dialogue {
    last: Vec<Last>,
    pub events: Vec<AgentEvent>,
}

impl Dialogue {
    pub fn new(population: usize) -> Self {
        Self {
            last: (0..population).map(|_| Last::default()).collect(),
            events: vec![],
        }
    }

    pub fn observe(
        &mut self,
        step: u32,
        scenario: &BuildingScenario,
        agents: &[Agent],
        routes: &[Option<Route>],
        statistics: &[AgentStatistics],
        windows: Option<&[WindowFrameState]>,
    ) {
        let mut service = BTreeMap::new();
        for window in windows.into_iter().flatten() {
            for &id in window.approaching_agent_ids.iter().flatten() {
                service.insert(id, (window.window_id.clone(), Kind::WindowApproach));
            }
            for &id in &window.queue_agent_ids {
                service.insert(id, (window.window_id.clone(), Kind::WindowQueue));
            }
            if let Some(&id) = window.queue_agent_ids.first() {
                let phase = match window.state {
                    WindowState::Breaking => Some(Kind::WindowBreaking),
                    WindowState::Opening => Some(Kind::WindowOpening),
                    _ => None,
                };
                if let Some(phase) = phase {
                    service.insert(id, (window.window_id.clone(), phase));
                }
            }
            if let Some(id) = window.traversing_agent_id {
                service.insert(id, (window.window_id.clone(), Kind::WindowTraversal));
            }
        }
        for (i, agent) in agents.iter().enumerate() {
            let last = &mut self.last[i];
            if last.done {
                continue;
            }
            let stat = &statistics[i];
            let mut say = |kind, subject_id: Option<String>, position| {
                self.events.push(AgentEvent {
                    step,
                    agent_id: agent.id,
                    kind,
                    subject_id,
                    position,
                    hazard_kind: scenario.disaster.map(|d| d.kind),
                })
            };
            if !last.exposed && stat.exposure_seconds > 0.0 {
                say(Kind::Exposure, None, Some(agent.position));
                last.exposed = true;
            }
            if stat.evacuation_step.is_some() || stat.shelter.is_some() {
                let subject = stat
                    .shelter
                    .as_ref()
                    .map(|s| s.id.clone())
                    .or_else(|| stat.escape_route.as_ref().map(|r| r.opening_id.clone()))
                    .or_else(|| stat.exit_id.clone());
                say(
                    if stat.shelter.is_some() {
                        Kind::Sheltered
                    } else {
                        Kind::Evacuated
                    },
                    subject,
                    Some(agent.position),
                );
                last.done = true;
                continue;
            }
            if let Some(area) = agent
                .known_hazards
                .values()
                .max_by_key(|area| (area.revision, area.id))
            {
                let update = match last.hazard {
                    None => Some(Kind::HazardDiscovered),
                    Some((old, time))
                        if f64::from(step - time) * scenario.time_step_seconds >= 5.0
                            && (area.radius - old.radius >= 0.5
                                || math::distance_to_point(area.center, old.center) >= 1.0) =>
                    {
                        Some(Kind::HazardSpreading)
                    }
                    _ => None,
                };
                if let Some(kind) = update {
                    say(kind, None, Some(area.center));
                    last.hazard = Some((*area, step));
                }
            }
            if let Some(window) = service.get(&agent.id) {
                if last.window.as_ref() != Some(window) {
                    say(window.1, Some(window.0.clone()), Some(agent.position));
                }
                last.window = Some(window.clone());
                last.goal = None;
                last.initialized = true;
                continue;
            }
            let goal = routes[i].as_ref().map(|route| route.exit_id.clone());
            if !last.initialized || goal != last.goal || last.window.is_some() {
                let kind = if goal.is_none() {
                    Kind::RouteUnavailable
                } else if last.initialized {
                    Kind::Rerouting
                } else {
                    Kind::HeadingToExit
                };
                say(kind, goal.clone(), Some(agent.position));
            }
            if !last.waited && f64::from(stat.waiting_steps) * scenario.time_step_seconds >= 2.0 {
                say(Kind::Waiting, None, Some(agent.position));
                last.waited = true;
            }
            last.goal = goal;
            last.window = None;
            last.initialized = true;
        }
    }
}
