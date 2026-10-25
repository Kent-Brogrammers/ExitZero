use super::{BuildingScenario, Point};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisasterKind {
    Fire,
    GasLeak,
    Tornado,
}

/// Prototype hazard footprint, not a calibrated physical prediction.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Disaster {
    pub kind: DisasterKind,
    pub center: Point,
    pub radius: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dynamics: Option<DisasterDynamics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShelterArrival {
    pub id: String,
    pub step: u32,
    pub seconds: f64,
}

impl Disaster {
    pub fn validate(&self, scenario: &BuildingScenario) -> Result<(), String> {
        if !self.center.x.is_finite()
            || !self.center.y.is_finite()
            || self.center.x < 0.0
            || self.center.y < 0.0
            || self.center.x > scenario.width
            || self.center.y > scenario.height
            || !self.radius.is_finite()
            || self.radius <= 0.0
            || self.radius > 1000.0
        {
            return Err(
                "disaster needs a finite in-bounds centre and radius in (0, 1000] metres".into(),
            );
        }
        if let Some(dynamics) = self.dynamics {
            dynamics.validate()?;
            if dynamics.enabled
                && self.kind != DisasterKind::Tornado
                && dynamics.max_radius < self.radius
            {
                return Err("maximum patch radius must be at least the initial radius".into());
            }
        }
        if self.kind == DisasterKind::Tornado && scenario.tornado_zones.is_empty() {
            return Err(
                "place at least one tornado zone before running a tornado simulation".into(),
            );
        }
        Ok(())
    }

    pub fn exposure_radius(&self) -> f64 {
        self.radius
            * match self.kind {
                DisasterKind::Fire => 1.6,
                DisasterKind::GasLeak => 2.0,
                DisasterKind::Tornado => 1.3,
            }
    }

    pub fn injury_rate(&self) -> f64 {
        match self.kind {
            DisasterKind::Fire => 0.035,
            DisasterKind::GasLeak => 0.018,
            DisasterKind::Tornado => 0.045,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisasterDynamics {
    pub enabled: bool,
    pub growth_rate: f64,
    pub spread_interval_seconds: f64,
    pub max_patches: u32,
    pub max_radius: f64,
    pub speed: f64,
    pub turn_rate_degrees: f64,
    pub wander_interval_seconds: f64,
    pub shelter_clearance: f64,
}

impl DisasterDynamics {
    pub fn validate(&self) -> Result<(), String> {
        let within = |v: f64, min: f64, max: f64| v.is_finite() && v >= min && v <= max;
        if !within(self.growth_rate, 0.0, 2.0)
            || !within(self.spread_interval_seconds, 0.25, 60.0)
            || !(1..=64).contains(&self.max_patches)
            || !within(self.max_radius, 0.01, 1000.0)
            || !within(self.speed, 0.0, 10.0)
            || !within(self.turn_rate_degrees, 1.0, 180.0)
            || !within(self.wander_interval_seconds, 0.25, 60.0)
            || !within(self.shelter_clearance, 0.0, 20.0)
        {
            return Err("invalid disaster dynamics: growth 0–2 m/s, interval 0.25–60 s, 1–64 patches, radius 0.01–1000 m, speed 0–10 m/s, turn rate 1–180 deg/s, clearance 0–20 m".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HazardArea {
    pub id: u32,
    pub revision: u32,
    pub center: Point,
    pub radius: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisasterState {
    pub kind: DisasterKind,
    pub areas: Vec<HazardArea>,
}

impl DisasterState {
    pub fn initial(disaster: Disaster) -> Self {
        Self {
            kind: disaster.kind,
            areas: vec![HazardArea {
                id: 0,
                revision: 0,
                center: disaster.center,
                radius: disaster.radius,
            }],
        }
    }
}

impl Default for DisasterDynamics {
    fn default() -> Self {
        Self {
            enabled: true,
            growth_rate: 0.06,
            spread_interval_seconds: 2.5,
            max_patches: 32,
            max_radius: 4.0,
            speed: 1.2,
            turn_rate_degrees: 50.0,
            wander_interval_seconds: 3.0,
            shelter_clearance: 0.5,
        }
    }
}
