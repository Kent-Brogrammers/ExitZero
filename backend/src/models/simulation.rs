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
    pub x: u32,
    pub y: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnimationFrame {
    pub step: u32,
    pub agents: Vec<AgentPosition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationResult {
    #[serde(flatten)]
    pub metrics: SimulationMetrics,
    pub frames: Vec<AnimationFrame>,
    pub cell_visits: Vec<u32>,
    pub width: u32,
    pub height: u32,
}

impl SimulationResult {
    pub fn validate(&self) -> Result<(), String> {
        self.metrics.validate()?;
        if !(1..=512).contains(&self.width)
            || !(1..=512).contains(&self.height)
            || self.cell_visits.len() != (self.width as usize) * (self.height as usize)
        {
            return Err("cell_visits must have width * height row-major entries".into());
        }
        let mut previous_step = None;
        for frame in &self.frames {
            if frame.step > 100_000 || previous_step.is_some_and(|step| step >= frame.step) {
                return Err("frame steps must be at most 100000 and strictly increasing".into());
            }
            previous_step = Some(frame.step);
            let mut ids = std::collections::HashSet::new();
            if frame.agents.len() > self.metrics.total_population as usize
                || frame.agents.iter().any(|agent| {
                    agent.x >= self.width || agent.y >= self.height || !ids.insert(agent.id)
                })
            {
                return Err("frames must contain unique agents within building bounds".into());
            }
        }
        Ok(())
    }
}
