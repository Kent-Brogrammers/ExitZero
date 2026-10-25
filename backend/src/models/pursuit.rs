use super::{BuildingScenario, Point};
use serde::{Deserialize, Serialize};

/// Optional fictional Halloween mode. Speeds and distances use metres/seconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PursuitConfig {
    pub stalker_start: Point,
    pub stalker_speed: f64,
    pub survivor_speed: f64,
    pub capture_radius: f64,
    pub avoidance_radius: f64,
}

impl PursuitConfig {
    pub fn validate(&self, building: &BuildingScenario) -> Result<(), String> {
        let point = self.stalker_start;
        if !point.x.is_finite()
            || !point.y.is_finite()
            || point.x < 0.0
            || point.y < 0.0
            || point.x > building.width
            || point.y > building.height
            || !self.stalker_speed.is_finite()
            || !(0.1..=3.0).contains(&self.stalker_speed)
            || !self.survivor_speed.is_finite()
            || !(0.1..=3.0).contains(&self.survivor_speed)
            || !self.capture_radius.is_finite()
            || self.capture_radius < 2.0 * building.agent_radius
            || self.capture_radius > 2.0 * building.agent_radius + 1.0
            || !self.avoidance_radius.is_finite()
            || self.avoidance_radius < self.capture_radius
            || self.avoidance_radius > 20.0
        {
            return Err("pursuit requires an in-bounds stalker start, speeds in [0.1, 3] m/s, a body-sized capture radius, and avoidance radius up to 20 m".into());
        }
        if building.disaster.is_some()
            || building
                .spawn_zones
                .iter()
                .map(|z| u64::from(z.count))
                .sum::<u64>()
                > 64
        {
            return Err("Halloween pursuit is a separate mode, with at most 64 survivors and no simultaneous disaster".into());
        }
        if building
            .windows
            .iter()
            .any(|w| w.emergency_escape.as_ref().is_some_and(|e| e.enabled))
        {
            return Err("Halloween pursuit currently uses doors and exits; emergency window service is available in ordinary evacuation mode".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaughtAgent {
    pub agent_id: u32,
    pub step: u32,
}

/// Survivors stay in frame.agents; the stalker is a separate actor and is never
/// counted as an occupant or an evacuation. Caught IDs are cumulative.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PursuitFrame {
    pub stalker: Point,
    pub escaped: u32,
    pub caught: Vec<CaughtAgent>,
}
