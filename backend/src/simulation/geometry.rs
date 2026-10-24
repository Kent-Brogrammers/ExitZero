use super::{Emergency, math};
use crate::models::{BuildingScenario, Point, Wall};

// Match the opening bounds/overlap tolerance in BuildingScenario validation.
const OPENING_EPSILON: f64 = 1e-8;

pub(super) struct Geometry<'a> {
    scenario: &'a BuildingScenario,
    emergencies: &'a [Emergency],
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
        Self {
            scenario,
            emergencies,
        }
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
        for wall in &self.scenario.walls {
            let clearance = self.scenario.agent_radius + wall.thickness / 2.0;
            for (start, end) in self.solid_wall_segments(wall) {
                let distance = math::distance_to_segment(pos, start, end);
                if distance < clearance {
                    return false;
                }
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

            if start - cursor > OPENING_EPSILON {
                segments.push((
                    math::interpolate(wall.start, wall.end, cursor / length),
                    math::interpolate(wall.start, wall.end, start / length),
                ));
            }
            cursor = cursor.max(end);
        }
        if length - cursor > OPENING_EPSILON {
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
        for wall in &self.scenario.walls {
            let clearance = self.scenario.agent_radius + wall.thickness / 2.0;
            for (start, end) in self.solid_wall_segments(wall) {
                let distance = math::distance_between_segments(from, to, start, end);
                if distance < clearance {
                    return false;
                }
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

#[cfg(test)]
mod opening_tolerance_tests {
    use super::*;
    use crate::models::Opening;

    fn scenario(angled: bool) -> BuildingScenario {
        let mut scenario: BuildingScenario =
            serde_json::from_str(include_str!("../../../shared/examples/building.json")).unwrap();
        scenario.walls = vec![Wall {
            id: "wall".into(),
            name: None,
            start: Point { x: 2.0, y: 2.0 },
            end: if angled {
                Point { x: 14.0, y: 11.0 }
            } else {
                Point { x: 17.0, y: 2.0 }
            },
            thickness: 0.2,
        }];
        scenario.doors.clear();
        scenario.exits.clear();
        scenario.blocked_exit_ids.clear();
        scenario.obstructions.clear();
        scenario
    }

    fn opening(id: &str, offset: f64, width: f64) -> Opening {
        Opening {
            id: id.into(),
            name: None,
            wall_id: "wall".into(),
            offset,
            width,
        }
    }

    #[test]
    fn microscopic_leading_intermediate_and_trailing_remnants_do_not_block_movement() {
        for angled in [false, true] {
            let mut scenario = scenario(angled);
            let wall = &scenario.walls[0];
            let length = wall.length();
            let mid = length / 2.0;
            let rounding = 1e-12;
            scenario.doors = vec![
                opening("a", rounding, mid - 2.0 * rounding),
                opening("b", mid + rounding, length - mid - 2.0 * rounding),
            ];
            let geometry = Geometry::new(&scenario);
            assert!(geometry.solid_wall_segments(wall).is_empty());
            let center = math::interpolate(wall.start, wall.end, 0.5);
            let normal = Point {
                x: -(wall.end.y - wall.start.y) / length,
                y: (wall.end.x - wall.start.x) / length,
            };
            assert!(geometry.can_move(
                Point {
                    x: center.x - normal.x,
                    y: center.y - normal.y
                },
                Point {
                    x: center.x + normal.x,
                    y: center.y + normal.y
                },
            ));
        }
    }

    #[test]
    fn real_separators_between_distinct_doors_remain_solid() {
        for angled in [false, true] {
            let mut scenario = scenario(angled);
            let wall = &scenario.walls[0];
            scenario.doors = vec![
                opening("a", 0.0, 2.0),
                opening("b", 2.05, wall.length() - 2.05),
            ];
            let geometry = Geometry::new(&scenario);
            let segments = geometry.solid_wall_segments(wall);
            assert_eq!(segments.len(), 1);
            assert!((math::distance_to_point(segments[0].0, segments[0].1) - 0.05).abs() < 1e-10);
            assert!(!geometry.can_stand_at(math::interpolate(
                wall.start,
                wall.end,
                2.025 / wall.length()
            )));
            assert_eq!(scenario.doors[0].id, "a");
            assert_eq!(scenario.doors[1].id, "b");
        }
    }

    #[test]
    fn blocking_a_full_segment_exit_restores_the_whole_solid_wall() {
        for angled in [false, true] {
            let mut scenario = scenario(angled);
            scenario.exits = vec![opening("exit", 0.0, scenario.walls[0].length())];
            assert!(
                Geometry::new(&scenario)
                    .solid_wall_segments(&scenario.walls[0])
                    .is_empty()
            );
            scenario.blocked_exit_ids.push("exit".into());
            let geometry = Geometry::new(&scenario);
            assert_eq!(geometry.solid_wall_segments(&scenario.walls[0]).len(), 1);
            assert!(!geometry.can_stand_at(math::interpolate(
                scenario.walls[0].start,
                scenario.walls[0].end,
                0.5
            )));
        }
    }
}
