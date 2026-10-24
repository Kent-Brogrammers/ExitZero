use super::{Emergency, math};
use crate::models::{BuildingScenario, Point, Wall};

pub(super) struct Geometry<'a> {
    scenario: &'a BuildingScenario,
    emergencies: &'a [Emergency],
    // Centreline pieces with rounded caps, plus their physical half-thickness.
    solid_walls: Vec<(Point, Point, f64)>,
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
        // Match the rounded-wall clearance used by playback and integration
        // checks. Cache the pieces rather than rebuilding them for every move.
        geometry.solid_walls = scenario
            .walls
            .iter()
            .flat_map(|wall| {
                geometry
                    .solid_wall_segments(wall)
                    .into_iter()
                    .map(|(start, end)| (start, end, wall.thickness / 2.0))
                    .collect::<Vec<_>>()
            })
            .collect();
        geometry
    }

    pub(super) fn emergencies(&self) -> &[Emergency] {
        self.emergencies
    }

    /// Centre-arrival evacuation requires approaching the exit without walking
    /// through it first. Keep avoidance and joint corrections on the current
    /// side of its wall, while allowing tangential movement to the target.
    pub(super) fn exit_approach_limits(
        &self,
        position: Point,
        exit_id: &str,
        dt: f64,
        clearance: f64,
    ) -> Vec<super::motion::VelocityLimit> {
        use super::motion::VelocityLimit;
        let Some(exit) = self.scenario.exits.iter().find(|exit| exit.id == exit_id) else {
            return Vec::new();
        };
        let Some(wall) = self
            .scenario
            .walls
            .iter()
            .find(|wall| wall.id == exit.wall_id)
        else {
            return Vec::new();
        };
        let normal = Point {
            x: -(wall.end.y - wall.start.y) / wall.length(),
            y: (wall.end.x - wall.start.x) / wall.length(),
        };
        let distance =
            (position.x - wall.start.x) * normal.x + (position.y - wall.start.y) * normal.y;
        let opposite = Point {
            x: -normal.x,
            y: -normal.y,
        };
        if distance.abs() <= 1e-9 {
            // At the plane there is no approach side. Stay on it and slide
            // toward the centre, including when roundoff changes the sign.
            vec![
                VelocityLimit {
                    normal,
                    offset: -distance / dt,
                },
                VelocityLimit {
                    normal: opposite,
                    offset: distance / dt,
                },
            ]
        } else {
            vec![VelocityLimit {
                normal: if distance > 0.0 { normal } else { opposite },
                offset: -(distance.abs() - clearance.min(distance.abs())) / dt,
            }]
        }
    }

    /// Supporting tangent planes keep the next velocity outside rounded walls,
    /// rectangles and hazards. Exact swept geometry remains the final authority.
    pub(super) fn velocity_limits(
        &self,
        position: Point,
        dt: f64,
    ) -> Vec<super::motion::VelocityLimit> {
        use super::motion::VelocityLimit;
        let horizon = dt.max(0.3);
        let mut limits = vec![
            VelocityLimit {
                normal: Point { x: 1.0, y: 0.0 },
                offset: -position.x / dt,
            },
            VelocityLimit {
                normal: Point { x: -1.0, y: 0.0 },
                offset: -(self.scenario.width - position.x) / dt,
            },
            VelocityLimit {
                normal: Point { x: 0.0, y: 1.0 },
                offset: -position.y / dt,
            },
            VelocityLimit {
                normal: Point { x: 0.0, y: -1.0 },
                offset: -(self.scenario.height - position.y) / dt,
            },
        ];
        let mut add = |nearest: Point, clearance: f64| {
            let dx = position.x - nearest.x;
            let dy = position.y - nearest.y;
            let distance = dx.hypot(dy);
            let gap = distance - clearance;
            if distance > 1e-12 && gap < super::motion::WALKING_SPEED * horizon {
                limits.push(VelocityLimit {
                    normal: Point {
                        x: dx / distance,
                        y: dy / distance,
                    },
                    offset: -gap.max(0.0) / horizon,
                });
            }
        };
        for &(start, end, half_thickness) in &self.solid_walls {
            add(
                math::closest_point_on_segment(position, start, end),
                self.scenario.agent_radius + half_thickness,
            );
        }
        for obstacle in &self.scenario.obstructions {
            add(
                Point {
                    x: position.x.clamp(obstacle.x, obstacle.x + obstacle.width),
                    y: position.y.clamp(obstacle.y, obstacle.y + obstacle.height),
                },
                self.scenario.agent_radius,
            );
        }
        for emergency in self.emergencies {
            add(
                emergency.center,
                self.scenario.agent_radius + emergency.radius + 1e-7,
            );
        }
        limits
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
        for &(start, end, half_thickness) in &self.solid_walls {
            if math::distance_to_segment(pos, start, end)
                < self.scenario.agent_radius + half_thickness
            {
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
        for &(start, end, half_thickness) in &self.solid_walls {
            if math::distance_between_segments(from, to, start, end)
                < self.scenario.agent_radius + half_thickness
            {
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
