use crate::models::{BuildingScenario, Point};

/// Static circular exclusion zone in metres. Radius includes the desired danger
/// buffer; collision checks also account for the agent's body radius.
#[derive(Debug, Clone, Copy)]
pub struct Emergency {
    pub center: Point,
    pub radius: f64,
}

impl Emergency {
    pub(super) fn validate(&self, scenario: &BuildingScenario) -> Result<(), String> {
        if !self.center.x.is_finite()
            || !self.center.y.is_finite()
            || self.center.x < 0.0
            || self.center.x > scenario.width
            || self.center.y < 0.0
            || self.center.y > scenario.height
            || !self.radius.is_finite()
            || self.radius <= 0.0
            || self.radius > 1000.0
        {
            return Err(
                "emergencies require an in-bounds finite centre and radius in (0, 1000] metres"
                    .into(),
            );
        }
        Ok(())
    }
}
