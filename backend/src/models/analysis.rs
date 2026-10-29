use super::{BuildingScenario, Obstruction, SimulationMetrics};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StressTestConfig {
    pub max_scenarios: u32,
    pub block_each_exit: bool,
    pub obstruction_candidates: Vec<Obstruction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StressTestRequest {
    pub building: BuildingScenario,
    pub config: StressTestConfig,
}

impl StressTestRequest {
    pub fn validate(&self) -> Result<(), String> {
        self.building.validate()?;
        if !(1..=100).contains(&self.config.max_scenarios) {
            return Err("max_scenarios must be between 1 and 100".into());
        }
        if self.config.obstruction_candidates.len() > 100 {
            return Err("at most 100 obstruction candidates are allowed".into());
        }
        let mut ids = std::collections::HashSet::new();
        for candidate in &self.config.obstruction_candidates {
            if !ids.insert(&candidate.id) {
                return Err("obstruction candidate IDs must be unique".into());
            }
            // Stress runs must retain the baseline placement. Existing furniture
            // may lie inside a spawn zone, but a new blocker must not change it.
            if self.building.spawn_zones.iter().any(|zone| {
                candidate.x < zone.x + zone.width
                    && zone.x < candidate.x + candidate.width
                    && candidate.y < zone.y + zone.height
                    && zone.y < candidate.y + candidate.height
            }) {
                return Err(
                    "stress-test obstruction candidates must not overlap spawn zones".into(),
                );
            }
            let mut modified = self.building.clone();
            modified.obstructions.push(candidate.clone());
            modified.validate()?;
            if self.building.placed_occupants.iter().any(|person| {
                (person.x - person.x.clamp(candidate.x, candidate.x + candidate.width))
                    .hypot(person.y - person.y.clamp(candidate.y, candidate.y + candidate.height))
                    < self.building.agent_radius
            }) {
                return Err(
                    "stress-test obstruction candidates must not overlap placed occupants".into(),
                );
            }
        }
        if !self.config.block_each_exit && self.config.obstruction_candidates.is_empty() {
            return Err("configure at least one stress scenario source".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScenarioModifications {
    /// Additional blockers applied to the baseline, not replacements.
    pub blocked_exit_ids: Vec<String>,
    pub added_obstructions: Vec<Obstruction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Low,
    Moderate,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StressScenarioResult {
    pub scenario_id: String,
    pub description: String,
    pub modifications: ScenarioModifications,
    pub metrics: SimulationMetrics,
    /// One-based, most severe first; tied scenarios may share a rank.
    pub rank: u32,
    pub severity: Severity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StressTestResult {
    pub baseline: SimulationMetrics,
    pub scenarios: Vec<StressScenarioResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OptimizeRequest {
    pub building: BuildingScenario,
    pub max_candidates: u32,
}

impl OptimizeRequest {
    pub fn validate(&self) -> Result<(), String> {
        self.building.validate()?;
        if !(1..=100).contains(&self.max_candidates) {
            return Err("max_candidates must be between 1 and 100".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OptimizationCandidate {
    pub building: BuildingScenario,
    pub metrics: SimulationMetrics,
    pub rank: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OptimizationResult {
    pub baseline: SimulationMetrics,
    pub candidates: Vec<OptimizationCandidate>,
}
