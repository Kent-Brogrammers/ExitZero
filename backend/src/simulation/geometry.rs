use super::{Emergency, math};
use crate::models::{BuildingScenario, Point, Wall};

pub(super) struct Geometry<'a> {
    scenario: &'a BuildingScenario,
    emergencies: &'a [Emergency],
    solid_walls: Vec<[Point; 4]>,
}

// Create geometry operations for a borrowed building scenario.
impl<'a> Geometry<'a> {
    pub(super) fn new(scenario: &'a BuildingScenario) -> Self {
        Self::with_emergencies(scenario, &[])
    }

    pub(super) fn with_emergencies(
        scenario: &'a BuildingScenario,
        emergencies: &'a [Emergency],
    ) -> Self {
        let mut geometry = Self {
            scenario,
            emergencies,
            solid_walls: Vec::new(),
        };
        // Openings cut flat ends through a wall, not rounded capsule ends.
        // Build these shapes once instead of splitting every wall on every check.
        geometry.solid_walls = scenario
            .walls
            .iter()
            .flat_map(|wall| {
                geometry
                    .solid_wall_segments(wall)
                    .into_iter()
                    .map(|(start, end)| {
                        let length = math::distance_to_point(start, end);
                        let nx = -(end.y - start.y) / length * wall.thickness / 2.0;
                        let ny = (end.x - start.x) / length * wall.thickness / 2.0;
                        [
                            Point {
                                x: start.x + nx,
                                y: start.y + ny,
                            },
                            Point {
                                x: end.x + nx,
                                y: end.y + ny,
                            },
                            Point {
                                x: end.x - nx,
                                y: end.y - ny,
                            },
                            Point {
                                x: start.x - nx,
                                y: start.y - ny,
                            },
                        ]
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        geometry
    }

    pub(super) fn emergencies(&self) -> &[Emergency] {
        self.emergencies
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
        if self.emergencies.iter().any(|emergency| {
            math::distance_to_point(pos, emergency.center)
                <= emergency.radius + self.scenario.agent_radius
        }) {
            return false;
        }

        // Check only solid wall portions; doors and available exits are gaps.
        for polygon in &self.solid_walls {
            if math::distance_to_polygon(pos, polygon) < self.scenario.agent_radius {
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

    fn solid_wall_segments(&self, wall: &Wall) -> Vec<(Point, Point)> {
        let mut openings: Vec<_> = self
            .scenario
            .doors
            .iter()
            .chain(
                self.scenario
                    .exits
                    .iter()
                    .filter(|exit| !self.scenario.blocked_exit_ids.contains(&exit.id)),
            )
            .filter(|opening| opening.wall_id == wall.id)
            .collect();

        openings.sort_by(|a, b| a.offset.total_cmp(&b.offset));

        let length = wall.length();
        let mut cursor = 0.0_f64;
        let mut segments = Vec::new();

        for opening in openings {
            let start = opening.offset.clamp(0.0, length);
            let end = (opening.offset + opening.width).clamp(0.0, length);

            if start > cursor {
                segments.push((
                    math::interpolate(wall.start, wall.end, cursor / length),
                    math::interpolate(wall.start, wall.end, start / length),
                ));
            }
            cursor = cursor.max(end);
        }
        if cursor < length {
            segments.push((
                math::interpolate(wall.start, wall.end, cursor / length),
                wall.end,
            ));
        }
        segments
    }

    pub(super) fn can_move(&self, from: Point, to: Point) -> bool {
        if !self.can_stand_at(from) || !self.can_stand_at(to) {
            return false;
        }
        if self.emergencies.iter().any(|emergency| {
            math::distance_to_segment(emergency.center, from, to)
                <= emergency.radius + self.scenario.agent_radius
        }) {
            return false;
        }
        //Checking path against all walls
        for polygon in &self.solid_walls {
            if math::distance_segment_to_polygon(from, to, polygon) < self.scenario.agent_radius {
                return false;
            }
        }
        //Checking path against all obstracles
        for obstruction in &self.scenario.obstructions {
            let distance = math::distance_segment_to_rectangle(
                from,
                to,
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
