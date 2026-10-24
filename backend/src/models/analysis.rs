use super::{BuildingScenario, Cell, SimulationMetrics};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StressTestConfig {
    pub max_scenarios: u32,
    pub block_each_exit: bool,
    pub blocked_cell_candidates: Vec<Cell>,
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
        let cells = &self.config.blocked_cell_candidates;
        let unique: std::collections::HashSet<_> = cells.iter().collect();
        if cells.len() > 100
            || unique.len() != cells.len()
            || cells
                .iter()
                .any(|cell| cell.x >= self.building.width || cell.y >= self.building.height)
        {
            return Err(
                "blocked_cell_candidates must contain at most 100 unique in-bounds cells".into(),
            );
        }
        if !self.config.block_each_exit && cells.is_empty() {
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
    pub blocked_cells: Vec<Cell>,
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
