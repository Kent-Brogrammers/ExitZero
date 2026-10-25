use super::perception::{self, Occluder, WallKnowledge, WallSpan};
use super::{Emergency, math};
use crate::models::{BuildingScenario, Obstruction, Opening, Point, Wall};
use std::collections::BTreeSet;

// Match the opening bounds/overlap tolerance in BuildingScenario validation.
const OPENING_EPSILON: f64 = 1e-8;

pub(super) struct Geometry<'a> {
    scenario: &'a BuildingScenario,
    emergencies: Vec<Emergency>,
    obstructions: Vec<&'a Obstruction>,
    // Centreline pieces, physical half-thickness and supporting wall index.
    solid_walls: Vec<(Point, Point, f64, usize)>,
    blocked_openings: BTreeSet<String>,
    partial_knowledge: bool,
    observed_openings: BTreeSet<String>,
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
        let mut blocked: BTreeSet<_> = scenario.blocked_exit_ids.iter().cloned().collect();
        blocked.extend(
            scenario
                .doors
                .iter()
                .chain(&scenario.exits)
                .filter(|o| Self::layout_blocks_opening(scenario, o))
                .map(|o| o.id.clone()),
        );
        Self::with_blocked_openings(scenario, emergencies, blocked)
    }

    pub(super) fn with_blocked_openings(
        scenario: &'a BuildingScenario,
        emergencies: &'a [Emergency],
        blocked_openings: BTreeSet<String>,
    ) -> Self {
        Self::build(
            scenario,
            emergencies,
            blocked_openings,
            false,
            BTreeSet::new(),
        )
    }

    pub(super) fn for_beliefs(
        scenario: &'a BuildingScenario,
        emergencies: &'a [Emergency],
        blocked_openings: BTreeSet<String>,
        observed_openings: &BTreeSet<String>,
        known_emergencies: &BTreeSet<usize>,
        known_obstructions: &BTreeSet<String>,
        known_walls: &WallKnowledge,
    ) -> Self {
        let mut geometry = Self::build(
            scenario,
            emergencies,
            blocked_openings,
            true,
            observed_openings.clone(),
        );
        geometry.emergencies = emergencies
            .iter()
            .enumerate()
            .filter(|(index, _)| known_emergencies.contains(index))
            .map(|(_, &emergency)| emergency)
            .collect();
        geometry
            .obstructions
            .retain(|obstacle| known_obstructions.contains(&obstacle.id));
        let complete = std::mem::take(&mut geometry.solid_walls);
        for (start, end, half_thickness, index) in complete {
            let wall = &scenario.walls[index];
            let Some(spans) = known_walls.get(&wall.id) else {
                continue;
            };
            let length = wall.length();
            let offset = |point: Point| {
                ((point.x - wall.start.x) * (wall.end.x - wall.start.x)
                    + (point.y - wall.start.y) * (wall.end.y - wall.start.y))
                    / length
            };
            let source_start = offset(start);
            let source_end = offset(end);
            for span in spans {
                let left = source_start.max(span.start);
                let right = source_end.min(span.end);
                if left <= right {
                    geometry.solid_walls.push((
                        math::interpolate(wall.start, wall.end, left / length),
                        math::interpolate(wall.start, wall.end, right / length),
                        half_thickness,
                        index,
                    ));
                }
            }
        }
        geometry
    }

    fn build(
        scenario: &'a BuildingScenario,
        emergencies: &'a [Emergency],
        blocked_openings: BTreeSet<String>,
        partial_knowledge: bool,
        observed_openings: BTreeSet<String>,
    ) -> Self {
        let mut geometry = Self {
            scenario,
            emergencies: emergencies.to_vec(),
            obstructions: scenario.obstructions.iter().collect(),
            solid_walls: Vec::new(),
            blocked_openings,
            partial_knowledge,
            observed_openings,
        };
        // Match the rounded-wall clearance used by playback and integration
        // checks. Cache the pieces rather than rebuilding them for every move.
        geometry.solid_walls = scenario
            .walls
            .iter()
            .enumerate()
            .flat_map(|(index, wall)| {
                geometry
                    .solid_wall_segments(wall)
                    .into_iter()
                    .map(|(start, end)| (start, end, wall.thickness / 2.0, index))
                    .collect::<Vec<_>>()
            })
            .collect();
        geometry
    }

    pub(super) fn wall_fragments(&self) -> impl Iterator<Item = (Point, Point, f64)> + '_ {
        self.solid_walls
            .iter()
            .map(|&(start, end, half_thickness, _)| (start, end, half_thickness))
    }

    pub(super) fn opening_was_observed(&self, id: &str) -> bool {
        !self.partial_knowledge || self.observed_openings.contains(id)
    }

    /// Observe only certified visible portions, clipped by range and occlusion.
    /// A source wall ID identifies memory; it never reveals the rest of a wall.
    pub(super) fn visible_walls(
        &self,
        from: Point,
        range: f64,
        known: &WallKnowledge,
    ) -> WallKnowledge {
        let mut observed = WallKnowledge::new();
        for (piece, &(start, end, half_thickness, index)) in self.solid_walls.iter().enumerate() {
            if math::distance_to_segment(from, start, end) - half_thickness > range {
                continue;
            }
            let wall = &self.scenario.walls[index];
            let length = math::distance_to_point(start, end);
            if length <= math::EPSILON {
                continue;
            }
            let tangent = Point {
                x: (end.x - start.x) / length,
                y: (end.y - start.y) / length,
            };
            let parent_offset =
                (start.x - wall.start.x) * tangent.x + (start.y - wall.start.y) * tangent.y;
            // Wall material is static. Fully remembered pieces cannot add any
            // new intervals; openings are observed independently every tick.
            if known.get(&wall.id).is_some_and(|spans| {
                spans
                    .iter()
                    .any(|span| span.start <= parent_offset && span.end >= parent_offset + length)
            }) {
                continue;
            }
            let mut occluders: Vec<_> = self
                .solid_walls
                .iter()
                .enumerate()
                .filter(|(other, _)| *other != piece)
                .map(|(_, &(a, b, radius, _))| Occluder::Capsule {
                    start: a,
                    end: b,
                    radius,
                })
                .collect();
            occluders.extend(self.obstructions.iter().map(|o| Occluder::Rectangle {
                x: o.x,
                y: o.y,
                width: o.width,
                height: o.height,
            }));
            let normal = Point {
                x: -tangent.y,
                y: tangent.x,
            };
            let side = (from.x - start.x) * normal.x + (from.y - start.y) * normal.y;
            if side.abs() > 1e-9 {
                let shift = half_thickness * side.signum();
                let face_start = Point {
                    x: start.x + normal.x * shift,
                    y: start.y + normal.y * shift,
                };
                let face_end = Point {
                    x: end.x + normal.x * shift,
                    y: end.y + normal.y * shift,
                };
                for span in
                    perception::visible_intervals(from, face_start, face_end, range, &occluders)
                {
                    observed.entry(wall.id.clone()).or_default().push(WallSpan {
                        start: parent_offset + span.start * length,
                        end: parent_offset + span.end * length,
                    });
                }
            }
            // A visible end cap reveals its endpoint, not the wall extending
            // behind it. This also handles looking exactly along a wall.
            for (endpoint, direction, offset) in [
                (start, -1.0, parent_offset),
                (end, 1.0, parent_offset + length),
            ] {
                let outward = ((from.x - endpoint.x) * tangent.x
                    + (from.y - endpoint.y) * tangent.y)
                    * direction;
                if outward < -math::EPSILON {
                    continue;
                }
                let distance = math::distance_to_point(from, endpoint);
                if distance - half_thickness > range {
                    continue;
                }
                let surface =
                    math::move_toward(from, endpoint, (distance - half_thickness).max(0.0));
                if !occluders
                    .iter()
                    .any(|&occluder| occluder.blocks_ray(from, surface))
                {
                    observed.entry(wall.id.clone()).or_default().push(WallSpan {
                        start: offset,
                        end: offset,
                    });
                }
            }
        }
        observed
    }

    pub(super) fn emergencies(&self) -> &[Emergency] {
        &self.emergencies
    }

    pub(super) fn obstructions(&self) -> impl Iterator<Item = &Obstruction> {
        self.obstructions.iter().copied()
    }

    pub(super) fn opening_is_blocked(&self, id: &str) -> bool {
        self.blocked_openings.contains(id)
    }

    fn opening_center(scenario: &BuildingScenario, opening: &Opening) -> Point {
        let wall = scenario
            .walls
            .iter()
            .find(|w| w.id == opening.wall_id)
            .unwrap();
        math::interpolate(
            wall.start,
            wall.end,
            (opening.offset + opening.width / 2.0) / wall.length(),
        )
    }

    pub(super) fn layout_blocks_opening(scenario: &BuildingScenario, opening: &Opening) -> bool {
        let center = Self::opening_center(scenario, opening);
        // Test the other walls' actual solid portions. Their own open doors
        // must not become phantom closures, especially on short curve segments.
        let layout = Geometry {
            scenario,
            emergencies: Vec::new(),
            obstructions: Vec::new(),
            solid_walls: Vec::new(),
            blocked_openings: scenario.blocked_exit_ids.iter().cloned().collect(),
            partial_knowledge: false,
            observed_openings: BTreeSet::new(),
        };
        scenario.walls.iter().any(|wall| {
            wall.id != opening.wall_id
                && math::distance_to_segment(center, wall.start, wall.end)
                    < scenario.agent_radius + wall.thickness / 2.0
                && layout
                    .solid_wall_segments(wall)
                    .iter()
                    .any(|&(start, end)| {
                        let dx = end.x - start.x;
                        let dy = end.y - start.y;
                        let projection = ((center.x - start.x) * dx + (center.y - start.y) * dy)
                            / (dx * dx + dy * dy);
                        // Nearby jamb caps constrain body clearance, but do not
                        // mean a neighboring opening has physically closed.
                        (0.0..=1.0).contains(&projection)
                            && math::distance_to_segment(center, start, end)
                                < scenario.agent_radius + wall.thickness / 2.0
                    })
        })
    }

    /// Local cut used only to see a closure without that closure occluding
    /// itself. Planning geometry never cuts holes through observed material.
    fn covering_wall_gap(&self, wall: &Wall, opening: &Opening) -> Option<(f64, f64)> {
        let center = Self::opening_center(self.scenario, opening);
        if wall.id == opening.wall_id
            || math::distance_to_segment(center, wall.start, wall.end)
                >= self.scenario.agent_radius + wall.thickness / 2.0
        {
            return None;
        }
        let support = self
            .scenario
            .walls
            .iter()
            .find(|w| w.id == opening.wall_id)
            .unwrap();
        let tangent = Point {
            x: (support.end.x - support.start.x) / support.length(),
            y: (support.end.y - support.start.y) / support.length(),
        };
        let normal = Point {
            x: -tangent.y,
            y: tangent.x,
        };
        let mut enter = 0.0_f64;
        let mut leave = 1.0_f64;
        // Expand for the covering segment's rounded caps. The supporting wall
        // still enforces the original door/exit width outside this local cut.
        for (axis, extent) in [
            (tangent, opening.width / 2.0 + wall.thickness / 2.0 + 1e-6),
            (
                normal,
                support.thickness / 2.0 + wall.thickness / 2.0 + self.scenario.agent_radius + 1e-6,
            ),
        ] {
            let origin = (wall.start.x - center.x) * axis.x + (wall.start.y - center.y) * axis.y;
            let delta = (wall.end.x - wall.start.x) * axis.x + (wall.end.y - wall.start.y) * axis.y;
            if delta.abs() < 1e-12 {
                if origin.abs() > extent {
                    return None;
                }
            } else {
                let a = (-extent - origin) / delta;
                let b = (extent - origin) / delta;
                enter = enter.max(a.min(b));
                leave = leave.min(a.max(b));
                if enter >= leave {
                    return None;
                }
            }
        }
        Some((enter * wall.length(), leave * wall.length()))
    }

    /// Vision is a ray, not an agent-sized movement segment. Solid walls and
    /// obstructions occlude it, including closed doors between two agents.
    pub(super) fn has_line_of_sight(&self, from: Point, to: Point) -> bool {
        self.ray_is_clear(from, to, &[], None)
    }

    fn ray_is_clear(
        &self,
        from: Point,
        to: Point,
        replaced_walls: &[usize],
        visible_obstruction: Option<&str>,
    ) -> bool {
        !self.solid_walls.iter().any(|&(a, b, thickness, index)| {
            !replaced_walls.contains(&index)
                && math::distance_between_segments(from, to, a, b) <= thickness
        }) && !self.obstructions.iter().any(|o| {
            visible_obstruction != Some(o.id.as_str())
                && math::distance_segment_to_rectangle(from, to, o.x, o.y, o.width, o.height)
                    <= 1e-9
        })
    }

    /// Observe the nearest surface of this obstruction without treating that
    /// surface as its own occluder. Other walls and obstructions still hide it.
    pub(super) fn can_see_obstruction(&self, from: Point, obstacle: &Obstruction) -> bool {
        let surface = Point {
            x: from.x.clamp(obstacle.x, obstacle.x + obstacle.width),
            y: from.y.clamp(obstacle.y, obstacle.y + obstacle.height),
        };
        self.ray_is_clear(from, surface, &[], Some(&obstacle.id))
    }

    pub(super) fn can_see_opening(&self, from: Point, opening: &crate::models::Opening) -> bool {
        let (wall_index, wall) = self
            .scenario
            .walls
            .iter()
            .enumerate()
            .find(|(_, wall)| wall.id == opening.wall_id)
            .unwrap();
        let target = math::interpolate(
            wall.start,
            wall.end,
            (opening.offset + opening.width / 2.0) / wall.length(),
        );
        if !self.opening_is_blocked(&opening.id) {
            return self.has_line_of_sight(from, target);
        }
        // A closed opening must be observable without occluding itself. Test
        // the full ray against every other barrier, then the supporting wall
        // with only this opening revealed. Never trim away part of the ray or
        // ignore adjacent solid portions of the supporting wall.
        let revealed: Vec<_> = self
            .scenario
            .walls
            .iter()
            .enumerate()
            .filter(|(index, candidate)| {
                *index == wall_index || self.covering_wall_gap(candidate, opening).is_some()
            })
            .map(|(index, _)| index)
            .collect();
        self.ray_is_clear(from, target, &revealed, None)
            && revealed.iter().all(|&index| {
                let wall = &self.scenario.walls[index];
                !self
                    .wall_segments_with_visible_opening(wall, Some(&opening.id))
                    .iter()
                    .any(|&(a, b)| {
                        math::distance_between_segments(from, target, a, b) <= wall.thickness / 2.0
                    })
            })
    }

    /// Usable centre positions on the exit plane, inset from rounded jambs.
    /// Other obstacles are still checked by can_move/can_stand_at.
    pub(super) fn exit_segment(&self, exit_id: &str) -> Option<(Point, Point)> {
        if self.opening_is_blocked(exit_id) {
            return None;
        }
        let exit = self.scenario.exits.iter().find(|exit| exit.id == exit_id)?;
        let wall = self
            .scenario
            .walls
            .iter()
            .find(|wall| wall.id == exit.wall_id)?;
        let clearance = self.scenario.agent_radius + wall.thickness / 2.0 + 1e-6;
        if exit.width < 2.0 * clearance {
            return None;
        }
        Some((
            math::interpolate(
                wall.start,
                wall.end,
                (exit.offset + clearance) / wall.length(),
            ),
            math::interpolate(
                wall.start,
                wall.end,
                (exit.offset + exit.width - clearance) / wall.length(),
            ),
        ))
    }

    pub(super) fn at_exit(&self, position: Point, exit_id: &str) -> bool {
        self.exit_segment(exit_id).is_some_and(|(start, end)| {
            math::distance_to_segment(position, start, end) <= math::EPSILON
                && self.can_stand_at(position)
        })
    }

    /// Forecast a sighted person's straight-line motion on this observer's
    /// belief map. None means a predicted exit arrival, never a real evacuation.
    pub(super) fn predict_occupant(
        &self,
        from: Point,
        velocity: Point,
        seconds: f64,
    ) -> Option<Point> {
        if !self.can_stand_at(from) {
            return Some(from);
        }
        let to = Point {
            x: from.x + velocity.x * seconds,
            y: from.y + velocity.y * seconds,
        };
        for exit in &self.scenario.exits {
            let Some((start, end)) = self.exit_segment(&exit.id) else {
                continue;
            };
            let dx = end.x - start.x;
            let dy = end.y - start.y;
            let a = (from.x - start.x) * dy - (from.y - start.y) * dx;
            let b = (to.x - start.x) * dy - (to.y - start.y) * dx;
            if (a - b).abs() <= 1e-12 || a * b > 0.0 {
                continue;
            }
            let crossing = math::interpolate(from, to, a / (a - b));
            if math::distance_to_segment(crossing, start, end) <= math::EPSILON
                && self.can_move(from, crossing)
            {
                return None;
            }
        }
        if self.can_move(from, to) {
            return Some(to);
        }
        // A forecast cannot pass through a remembered wall, obstacle, hazard,
        // or workspace boundary. Stop just before its first blocked segment.
        let (mut clear, mut blocked) = (0.0, 1.0);
        for _ in 0..10 {
            let middle = (clear + blocked) * 0.5;
            if self.can_move(from, math::interpolate(from, to, middle)) {
                clear = middle;
            } else {
                blocked = middle;
            }
        }
        Some(math::interpolate(from, to, clear))
    }

    /// Stop on the exit plane for arrival accounting. Tangential movement is
    /// unrestricted, so all usable positions across the opening remain available.
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
            // At the plane there is no approach side. Keep roundoff from
            // switching it while arrival is checked.
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
                offset: (-(distance.abs() - clearance) / dt).min(super::motion::WALKING_SPEED),
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
        for &(start, end, half_thickness, _) in &self.solid_walls {
            add(
                math::closest_point_on_segment(position, start, end),
                self.scenario.agent_radius + half_thickness,
            );
        }
        for obstacle in &self.obstructions {
            add(
                Point {
                    x: position.x.clamp(obstacle.x, obstacle.x + obstacle.width),
                    y: position.y.clamp(obstacle.y, obstacle.y + obstacle.height),
                },
                self.scenario.agent_radius,
            );
        }
        for emergency in &self.emergencies {
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
        for &(start, end, half_thickness, _) in &self.solid_walls {
            if math::distance_to_segment(pos, start, end)
                < self.scenario.agent_radius + half_thickness
            {
                return false;
            }
        }

        // Current rectangular obstacles are converted to polygons by the helper.
        for obstruction in &self.obstructions {
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
        self.wall_segments_with_visible_opening(wall, None)
    }

    fn wall_segments_with_visible_opening(
        &self,
        wall: &Wall,
        visible: Option<&str>,
    ) -> Vec<(Point, Point)> {
        let mut intervals: Vec<_> = self
            .scenario
            .doors
            .iter()
            .filter(|door| !self.opening_is_blocked(&door.id) || visible == Some(door.id.as_str()))
            .chain(self.scenario.exits.iter().filter(|exit| {
                !self.opening_is_blocked(&exit.id) || visible == Some(exit.id.as_str())
            }))
            .filter(|opening| opening.wall_id == wall.id)
            .map(|opening| (opening.offset, opening.offset + opening.width))
            .collect();
        for opening in self.scenario.doors.iter().chain(&self.scenario.exits) {
            if visible == Some(opening.id.as_str())
                && let Some(gap) = self.covering_wall_gap(wall, opening)
            {
                intervals.push(gap);
            }
        }
        intervals.sort_by(|a, b| a.0.total_cmp(&b.0));

        let length = wall.length();
        let mut cursor = 0.0_f64;
        let mut segments = Vec::new();

        for (start, end) in intervals {
            let start = start.clamp(0.0, length);
            let end = end.clamp(0.0, length);

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
        for &(start, end, half_thickness, _) in &self.solid_walls {
            if math::distance_between_segments(from, to, start, end)
                < self.scenario.agent_radius + half_thickness
            {
                return false;
            }
        }
        //Checking path against all obstracles
        for obstruction in &self.obstructions {
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
