use super::math;
use crate::models::{BuildingScenario, Point};

pub(super) struct Geometry<'a> {
    scenario: &'a BuildingScenario,
}

// Create geometry operations for a borrowed building scenario.
impl<'a> Geometry<'a> {
    pub(super) fn new(scenario: &'a BuildingScenario) -> Self {
        Self { scenario }
    }

    // Check a point against the workspace extent, without agent-radius clearance.
    pub(super) fn is_within_workspace(&self, position: Point) -> bool {
        position.x.is_finite()
            && position.y.is_finite()
            && position.x >= 0.0
            && position.y >= 0.0
            && position.x <= self.scenario.width
            && position.y <= self.scenario.height
    }
    pub(super) fn can_stand_at(&self, pos: Point) -> bool {
        if !self.is_within_workspace(pos) {
            return false;
        }

        // Current contracts provide straight walls. Curved walls can use
        // the same polyline helper once their points are supplied by the model.
        // Door and exit openings still need to be removed from solid walls.
        for wall in &self.scenario.walls {
            let clearance = self.scenario.agent_radius + wall.thickness / 2.0;
            let distance = math::distance_to_polyline(pos, &[wall.start, wall.end]);

            if distance < clearance {
                return false;
            }
        }

        // Current rectangular obstacles are converted to polygons by the helper.
        for obstruction in &self.scenario.obstructions {
            let distance = math::distance_to_rectangle(
                pos,
                obstruction.x,
                obstruction.y,
                obstruction.width,
                obstruction.height,
            );
            if distance < self.scenario.agent_radius {
                return false;
            }
        }

        true
    }
}
