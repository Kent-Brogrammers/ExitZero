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
    /// Trapped is a subset of remaining, not an additional population category.
    pub trapped: u32,
    pub remaining: u32,
    pub clearance_steps: Option<u32>,
}

impl SimulationMetrics {
    pub fn validate(&self) -> Result<(), String> {
        if self.clearance_steps.is_some_and(|steps| steps > 100_000) {
            return Err("clearance_steps must be at most 100000".into());
        }
        if self.total_population == 0
            || self.total_population > 10_000
            || u64::from(self.evacuated) + u64::from(self.remaining)
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnimationFrame {
    pub step: u32,
    pub agents: Vec<AgentPosition>,
    /// Physical state at this frame; absent in legacy recordings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_opening_ids: Option<Vec<String>>,
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
    /// False means the sampled navigation graph found no route, not proven trapped.
    pub route_found: bool,
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
                        || did_evacuate != agent.exit_id.is_some()
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
            let mut ids = std::collections::HashSet::new();
            if frame.agents.len() > self.metrics.total_population as usize
                || frame
                    .agents
                    .iter()
                    .any(|agent| !self.in_bounds(agent.x, agent.y) || !ids.insert(agent.id))
            {
                return Err("frames must contain unique agents with finite positions within building bounds".into());
            }
        }
        Ok(())
    }
}
