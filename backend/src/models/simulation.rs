use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SimulationStatus {
    Completed,
    Incomplete,
    Timeout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationMetrics {
    pub status: SimulationStatus,
    pub total_population: u32,
    pub evacuated: u32,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub sheltered: u32,
    /// Trapped is a subset of remaining, not an additional population category.
    pub trapped: u32,
    pub remaining: u32,
    pub clearance_steps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evacuated_by_route: Option<super::EvacuatedByRoute>,
}

impl SimulationMetrics {
    pub fn validate(&self) -> Result<(), String> {
        if self.evacuated_by_route.as_ref().is_some_and(|counts| {
            u64::from(counts.normal_exit) + u64::from(counts.emergency_window)
                != u64::from(self.evacuated)
        }) {
            return Err("escape route counts must sum to evacuated".into());
        }
        if self.clearance_steps.is_some_and(|steps| steps > 100_000) {
            return Err("clearance_steps must be at most 100000".into());
        }
        if self.total_population == 0
            || self.total_population > 10_000
            || u64::from(self.evacuated) + u64::from(self.sheltered) + u64::from(self.remaining)
                != u64::from(self.total_population)
            || self.trapped > self.remaining
        {
            return Err("invalid population totals; trapped must be a subset of remaining".into());
        }
        match self.status {
            SimulationStatus::Completed
                if self.remaining != 0 || self.clearance_steps.is_none() =>
            {
                Err("completed results require zero remaining and a clearance time".into())
            }
            SimulationStatus::Incomplete | SimulationStatus::Timeout
                if self.remaining == 0 || self.clearance_steps.is_some() =>
            {
                Err(
                    "unfinished results require remaining occupants and null clearance_steps"
                        .into(),
                )
            }
            _ => Ok(()),
        }
    }

    /// Greater means worse: un-evacuated population, then trapped, then clearance.
    /// Missing clearance is worse than any measured clearance, never treated as zero.
    pub fn compare_severity(&self, other: &Self) -> Ordering {
        (
            self.remaining,
            self.trapped,
            self.clearance_steps.unwrap_or(u32::MAX),
        )
            .cmp(&(
                other.remaining,
                other.trapped,
                other.clearance_steps.unwrap_or(u32::MAX),
            ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentPosition {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub injury: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnimationFrame {
    pub step: u32,
    pub agents: Vec<AgentPosition>,
    /// Physical state at this frame; absent in legacy recordings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_opening_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_states: Option<Vec<super::WindowFrameState>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheltered: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disaster_state: Option<super::DisasterState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrafficSample {
    pub x: f64,
    pub y: f64,
    pub visits: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentStatistics {
    /// Same stable ID used in animation frames.
    pub id: u32,
    /// Actual accepted movement, including detours; never inferred from frames.
    pub distance_metres: f64,
    /// Full ticks where a proposed movement was rejected by collision checks.
    /// Agents without a route do not accumulate waiting time.
    pub waiting_steps: u32,
    pub waiting_seconds: f64,
    /// Time until evacuation, or until the run ended for remaining occupants.
    pub elapsed_seconds: f64,
    pub evacuation_step: Option<u32>,
    pub evacuation_seconds: Option<f64>,
    /// Successful exit ID, null for occupants that did not evacuate.
    pub exit_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escape_route: Option<super::EscapeRoute>,
    /// False means the sampled navigation graph found no route, not proven trapped.
    pub route_found: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shelter: Option<super::ShelterArrival>,
    #[serde(default, skip_serializing_if = "is_zero_f64")]
    pub injury: f64,
    #[serde(default, skip_serializing_if = "is_zero_f64")]
    pub exposure_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SimulationAnalytics {
    pub agents: Vec<AgentStatistics>,
    pub simulated_seconds: f64,
    /// Median among evacuated occupants ONLY, including on incomplete runs.
    /// Null when nobody evacuated; never treat remaining occupants as zero time.
    pub median_evacuation_seconds: Option<f64>,
    pub total_distance_metres: f64,
    pub total_waiting_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationResult {
    #[serde(flatten)]
    pub metrics: SimulationMetrics,
    pub frames: Vec<AnimationFrame>,
    pub traffic_samples: Vec<TrafficSample>,
    pub width: f64,
    pub height: f64,
    pub time_step_seconds: f64,
    /// Optional for compatibility with older saved results and synthetic fixtures.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analytics: Option<SimulationAnalytics>,
    /// None for legacy recordings; Some([]) means no new opening information.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub communication_events: Option<Vec<super::CommunicationEvent>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_events: Option<Vec<super::AgentEvent>>,
}

impl SimulationResult {
    fn in_bounds(&self, x: f64, y: f64) -> bool {
        x.is_finite()
            && y.is_finite()
            && x >= 0.0
            && y >= 0.0
            && x <= self.width
            && y <= self.height
    }

    pub fn validate(&self) -> Result<(), String> {
        self.metrics.validate()?;
        if let Some(analytics) = &self.analytics {
            if let Some(counts) = &self.metrics.evacuated_by_route {
                let window_count = analytics
                    .agents
                    .iter()
                    .filter(|a| {
                        a.escape_route
                            .as_ref()
                            .is_some_and(|r| r.kind == super::EscapeRouteKind::EmergencyWindow)
                    })
                    .count() as u32;
                if window_count != counts.emergency_window {
                    return Err("escape route totals disagree with per-agent outcomes".into());
                }
            }
            let nonnegative = |value: f64| value.is_finite() && value >= 0.0;
            let mut ids = std::collections::HashSet::new();
            if analytics.agents.len() != self.metrics.total_population as usize
                || !nonnegative(analytics.simulated_seconds)
                || !nonnegative(analytics.total_distance_metres)
                || !nonnegative(analytics.total_waiting_seconds)
                || analytics
                    .median_evacuation_seconds
                    .is_some_and(|value| !nonnegative(value))
                || analytics.agents.iter().any(|agent| {
                    let did_evacuate = agent.evacuation_step.is_some();
                    !ids.insert(agent.id)
                        || !agent.injury.is_finite()
                        || !(0.0..=1.0).contains(&agent.injury)
                        || !nonnegative(agent.exposure_seconds)
                        || agent.exposure_seconds > agent.elapsed_seconds + 1e-6
                        || agent.shelter.as_ref().is_some_and(|s| {
                            did_evacuate
                                || s.id.is_empty()
                                || s.step > 100_000
                                || !nonnegative(s.seconds)
                                || (s.seconds - agent.elapsed_seconds).abs() > 1e-6
                                || (s.seconds - f64::from(s.step) * self.time_step_seconds).abs()
                                    > 1e-6
                        })
                        || !nonnegative(agent.distance_metres)
                        || !nonnegative(agent.waiting_seconds)
                        || !nonnegative(agent.elapsed_seconds)
                        || agent.waiting_seconds > agent.elapsed_seconds + 1e-6
                        || agent.elapsed_seconds > analytics.simulated_seconds + 1e-6
                        || agent.waiting_steps > 100_000
                        || (agent.waiting_seconds
                            - f64::from(agent.waiting_steps) * self.time_step_seconds)
                            .abs()
                            > 1e-6
                        || agent
                            .evacuation_step
                            .is_some_and(|step| step > 100_000 || !agent.route_found)
                        || agent.evacuation_seconds.is_some_and(|value| {
                            !nonnegative(value) || (value - agent.elapsed_seconds).abs() > 1e-6
                        })
                        || did_evacuate != agent.evacuation_seconds.is_some()
                        || did_evacuate != (agent.exit_id.is_some() || agent.escape_route.is_some())
                        || agent.escape_route.as_ref().is_some_and(|route| {
                            route.opening_id.trim().is_empty()
                                || match route.kind {
                                    super::EscapeRouteKind::NormalExit => {
                                        agent.exit_id.as_ref() != Some(&route.opening_id)
                                    }
                                    super::EscapeRouteKind::EmergencyWindow => {
                                        agent.exit_id.is_some()
                                    }
                                }
                        })
                        || agent
                            .evacuation_step
                            .zip(agent.evacuation_seconds)
                            .is_some_and(|(step, seconds)| {
                                (seconds - f64::from(step) * self.time_step_seconds).abs() > 1e-6
                            })
                })
                || analytics
                    .agents
                    .iter()
                    .filter(|agent| agent.evacuation_step.is_some())
                    .count()
                    != self.metrics.evacuated as usize
                || analytics
                    .agents
                    .iter()
                    .filter(|agent| agent.shelter.is_some())
                    .count()
                    != self.metrics.sheltered as usize
                || analytics.median_evacuation_seconds.is_some() != (self.metrics.evacuated > 0)
            {
                return Err("invalid per-agent analytics, times, or population accounting".into());
            }
        }
        if !self.width.is_finite()
            || self.width <= 0.0
            || self.width > 1000.0
            || !self.height.is_finite()
            || self.height <= 0.0
            || self.height > 1000.0
            || !self.time_step_seconds.is_finite()
            || self.time_step_seconds <= 0.0
            || self.time_step_seconds > 1.0
            || self.traffic_samples.len() > 100_000
            || self
                .traffic_samples
                .iter()
                .any(|sample| !self.in_bounds(sample.x, sample.y))
        {
            return Err("invalid workspace, time step, or continuous traffic samples".into());
        }
        let mut previous_step = None;
        for frame in &self.frames {
            if frame.step > 100_000 || previous_step.is_some_and(|step| step >= frame.step) {
                return Err("frame steps must be at most 100000 and strictly increasing".into());
            }
            previous_step = Some(frame.step);
            if let Some(state) = &frame.disaster_state {
                let mut area_ids = std::collections::HashSet::new();
                if state.areas.is_empty()
                    || state.areas.len() > 64
                    || state.areas.iter().any(|area| {
                        !area_ids.insert(area.id)
                            || area.revision > frame.step
                            || !self.in_bounds(area.center.x, area.center.y)
                            || !area.radius.is_finite()
                            || area.radius <= 0.0
                            || area.radius > 1000.0
                    })
                {
                    return Err("invalid disaster footprint in animation frame".into());
                }
            }
            let mut ids = std::collections::HashSet::new();
            if frame.agents.len() > self.metrics.total_population as usize
                || frame.agents.iter().any(|agent| {
                    !self.in_bounds(agent.x, agent.y)
                        || !ids.insert(agent.id)
                        || agent.injury.is_some_and(|injury| {
                            !injury.is_finite() || !(0.0..=1.0).contains(&injury)
                        })
                })
            {
                return Err("frames must contain unique agents with finite positions within building bounds".into());
            }
            if let Some(states) = &frame.window_states {
                let mut windows = std::collections::HashSet::new();
                let mut participants = std::collections::HashSet::new();
                if states.len() > 100
                    || states.iter().any(|s| {
                        !windows.insert(&s.window_id)
                            || s.window_id.trim().is_empty()
                            || s.window_id.chars().count() > 64
                            || s.unavailable_reason.as_ref().is_some_and(|reason| {
                                reason.trim().is_empty() || reason.chars().count() > 240
                            })
                            || s.approaching_agent_ids
                                .as_ref()
                                .is_some_and(|ids| ids.len() > 10_000)
                            || matches!(
                                s.state,
                                super::WindowState::Opening | super::WindowState::Breaking
                            ) && s.preparation_ready_step.is_none()
                            || s.state == super::WindowState::Intact
                                && s.preparation_ready_step.is_some()
                            || s.traversing_agent_id.is_some()
                                != s.traversal_earliest_finish_step.is_some()
                            || s.traversing_agent_id.is_some()
                                && !matches!(
                                    s.state,
                                    super::WindowState::Open | super::WindowState::Broken
                                )
                            || s.approaching_agent_ids
                                .iter()
                                .flatten()
                                .chain(s.queue_agent_ids.iter())
                                .chain(s.traversing_agent_id.iter())
                                .any(|id| !ids.contains(id) || !participants.insert(*id))
                    })
                {
                    return Err("invalid window state or queue membership in frame".into());
                }
            }
        }
        if let Some(events) = &self.agent_events {
            let ids: std::collections::HashSet<_> = self
                .frames
                .first()
                .into_iter()
                .flat_map(|f| f.agents.iter().map(|a| a.id))
                .chain(
                    self.analytics
                        .iter()
                        .flat_map(|a| a.agents.iter().map(|a| a.id)),
                )
                .collect();
            let last = self.frames.last().map_or(0, |f| f.step);
            let mut previous = 0;
            let mut seen = std::collections::HashSet::new();
            for event in events {
                use super::AgentEventKind::*;
                let needs_subject = matches!(
                    event.kind,
                    HeadingToExit
                        | Rerouting
                        | WindowApproach
                        | WindowQueue
                        | WindowOpening
                        | WindowBreaking
                        | WindowTraversal
                        | Evacuated
                        | Sheltered
                );
                if event.step < previous
                    || event.step > last
                    || !ids.contains(&event.agent_id)
                    || event
                        .subject_id
                        .as_ref()
                        .is_some_and(|id| id.trim().is_empty() || id.chars().count() > 64)
                    || needs_subject && event.subject_id.is_none()
                    || matches!(event.kind, HazardDiscovered | HazardSpreading)
                        && event.position.is_none()
                    || event.position.is_some_and(|p| !self.in_bounds(p.x, p.y))
                    || !seen.insert((event.step, event.kind, event.agent_id, &event.subject_id))
                {
                    return Err("invalid agent activity event time, subject or source".into());
                }
                previous = event.step;
            }
        }
        if let Some(events) = &self.communication_events {
            let ids: std::collections::HashSet<_> = self
                .frames
                .first()
                .into_iter()
                .flat_map(|f| f.agents.iter().map(|a| a.id))
                .chain(
                    self.analytics
                        .iter()
                        .flat_map(|a| a.agents.iter().map(|a| a.id)),
                )
                .collect();
            let last_step = self.frames.last().map(|f| f.step);
            let mut seen = std::collections::HashSet::new();
            let mut previous = 0;
            for event in events {
                let recipients: std::collections::HashSet<_> =
                    event.recipient_ids.iter().copied().collect();
                if event.step > 100_000
                    || event.step < previous
                    || last_step.is_none_or(|step| event.step > step)
                    || !ids.contains(&event.sender_id)
                    || event.opening_id.trim().is_empty()
                    || event.opening_id.chars().count() > 64
                    || match event.event_type {
                        super::CommunicationEventType::Discovery => !recipients.is_empty(),
                        super::CommunicationEventType::Shared => recipients.is_empty(),
                    }
                    || recipients.len() > 10000
                    || recipients.len() != event.recipient_ids.len()
                    || recipients.contains(&event.sender_id)
                    || recipients.iter().any(|id| !ids.contains(id))
                    || !seen.insert((
                        event.step,
                        event.event_type,
                        event.sender_id,
                        &event.opening_id,
                    ))
                {
                    return Err("invalid communication event time, source or recipients".into());
                }
                previous = event.step;
            }
        }
        Ok(())
    }
}

fn is_zero_u32(value: &u32) -> bool {
    *value == 0
}
fn is_zero_f64(value: &f64) -> bool {
    *value == 0.0
}
