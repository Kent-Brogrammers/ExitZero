use super::perception::{self, Occluder, WallKnowledge, WallSpan};
use super::{Emergency, math};
use crate::models::{BuildingScenario, Obstruction, Opening, Point, Wall};
use std::collections::BTreeSet;

// Match the opening bounds/overlap tolerance in BuildingScenario validation.
const OPENING_EPSILON: f64 = 1e-8;

#[derive(Clone, Copy)]
struct Bounds {
    min: Point,
    max: Point,
}

impl Bounds {
    fn segment(start: Point, end: Point, margin: f64) -> Self {
        Self {
            min: Point {
                x: start.x.min(end.x) - margin,
                y: start.y.min(end.y) - margin,
            },
            max: Point {
                x: start.x.max(end.x) + margin,
                y: start.y.max(end.y) + margin,
            },
        }
    }

    fn union(self, other: Self) -> Self {
        Self {
            min: Point {
                x: self.min.x.min(other.min.x),
                y: self.min.y.min(other.min.y),
            },
            max: Point {
                x: self.max.x.max(other.max.x),
                y: self.max.y.max(other.max.y),
            },
        }
    }

    fn overlaps(self, other: Self) -> bool {
        self.min.x <= other.max.x
            && self.max.x >= other.min.x
            && self.min.y <= other.max.y
            && self.max.y >= other.min.y
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Primitive {
    Wall(usize),
    Obstruction(usize),
}

struct IndexedPrimitive {
    bounds: Bounds,
    primitive: Primitive,
}

struct BoundsNode {
    bounds: Bounds,
    // Nodes are in preorder. A rejected subtree jumps directly to its end,
    // avoiding recursion, allocation, or a fixed-size query stack.
    end: usize,
    entries: std::ops::Range<usize>,
}

#[derive(Default)]
struct GeometryIndex {
    entries: Vec<IndexedPrimitive>,
    nodes: Vec<BoundsNode>,
}

impl GeometryIndex {
    fn new(mut entries: Vec<IndexedPrimitive>) -> Self {
        fn build(entries: &mut [IndexedPrimitive], offset: usize, nodes: &mut Vec<BoundsNode>) {
            let bounds = entries
                .iter()
                .skip(1)
                .fold(entries[0].bounds, |a, b| a.union(b.bounds));
            let index = nodes.len();
            nodes.push(BoundsNode {
                bounds,
                end: 0,
                entries: offset..offset + entries.len(),
            });
            if entries.len() > 4 {
                let split_x = bounds.max.x - bounds.min.x >= bounds.max.y - bounds.min.y;
                entries.sort_unstable_by(|a, b| {
                    let center = |p: &IndexedPrimitive| {
                        if split_x {
                            p.bounds.min.x + p.bounds.max.x
                        } else {
                            p.bounds.min.y + p.bounds.max.y
                        }
                    };
                    center(a)
                        .total_cmp(&center(b))
                        .then_with(|| a.primitive.cmp(&b.primitive))
                });
                let middle = entries.len() / 2;
                let (left, right) = entries.split_at_mut(middle);
                nodes[index].entries = 0..0;
                build(left, offset, nodes);
                build(right, offset + middle, nodes);
            }
            nodes[index].end = nodes.len();
        }

        let mut nodes = Vec::with_capacity(entries.len().saturating_mul(2));
        if !entries.is_empty() {
            build(&mut entries, 0, &mut nodes);
        }
        Self { entries, nodes }
    }

    fn any(&self, bounds: Bounds, mut test: impl FnMut(Primitive) -> bool) -> bool {
        let mut cursor = 0;
        while cursor < self.nodes.len() {
            let node = &self.nodes[cursor];
            if !node.bounds.overlaps(bounds) {
                cursor = node.end;
                continue;
            }
            for entry in &self.entries[node.entries.clone()] {
                if entry.bounds.overlaps(bounds) && test(entry.primitive) {
                    return true;
                }
            }
            cursor += 1;
        }
        false
    }
}

// Intersect a movement segment with a box expressed in two orthonormal axes.
fn box_interval(
    from: Point,
    to: Point,
    origin: Point,
    axes: [(Point, f64, f64); 2],
) -> Option<(f64, f64)> {
    let (mut enter, mut leave) = (0.0_f64, 1.0_f64);
    for (axis, low, high) in axes {
        let offset = (from.x - origin.x) * axis.x + (from.y - origin.y) * axis.y;
        let delta = (to.x - from.x) * axis.x + (to.y - from.y) * axis.y;
        if delta.abs() < 1e-12 {
            if offset < low || offset > high {
                return None;
            }
        } else {
            let a = (low - offset) / delta;
            let b = (high - offset) / delta;
            enter = enter.max(a.min(b));
            leave = leave.min(a.max(b));
            if enter > leave {
                return None;
            }
        }
    }
    Some((enter, leave))
}

// A capsule is its rectangular body plus circular end caps. Its intersection
// with a line is one interval; no sampling can miss a thin partition.
fn capsule_interval(
    from: Point,
    to: Point,
    start: Point,
    end: Point,
    radius: f64,
) -> Option<(f64, f64)> {
    let length = math::distance_to_point(start, end);
    let mut intervals = Vec::new();
    if length > math::EPSILON {
        let tangent = Point {
            x: (end.x - start.x) / length,
            y: (end.y - start.y) / length,
        };
        let normal = Point {
            x: -tangent.y,
            y: tangent.x,
        };
        if let Some(interval) = box_interval(
            from,
            to,
            start,
            [(tangent, 0.0, length), (normal, -radius, radius)],
        ) {
            intervals.push(interval);
        }
    }
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let square = dx * dx + dy * dy;
    if square <= math::EPSILON * math::EPSILON {
        return (math::distance_to_segment(from, start, end) <= radius).then_some((0.0, 1.0));
    }
    for center in [start, end] {
        let x = from.x - center.x;
        let y = from.y - center.y;
        let dot = x * dx + y * dy;
        let discriminant = dot * dot - square * (x * x + y * y - radius * radius);
        if discriminant >= 0.0 {
            let half = discriminant.sqrt();
            let enter = ((-dot - half) / square).max(0.0);
            let leave = ((-dot + half) / square).min(1.0);
            if enter <= leave {
                intervals.push((enter, leave));
            }
        }
    }
    intervals
        .into_iter()
        .reduce(|a, b| (a.0.min(b.0), a.1.max(b.1)))
}

pub(super) struct Geometry<'a> {
    scenario: &'a BuildingScenario,
    emergencies: Vec<Emergency>,
    obstructions: Vec<&'a Obstruction>,
    // Centreline pieces, physical half-thickness and supporting wall index.
    solid_walls: Vec<(Point, Point, f64, usize)>,
    index: GeometryIndex,
    blocked_openings: BTreeSet<String>,
    partial_knowledge: bool,
    observed_openings: BTreeSet<String>,
    service_apertures: Vec<Opening>,
    pub(super) disaster: Option<crate::models::Disaster>,
    pub(super) hazard_areas: Vec<crate::models::HazardArea>,
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
        let mut geometry = Self::build(
            scenario,
            emergencies,
            blocked_openings,
            false,
            BTreeSet::new(),
        );
        geometry.rebuild_index();
        geometry
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
        geometry.disaster = None;
        geometry.hazard_areas.clear();
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
        geometry.rebuild_index();
        geometry
    }

    // Private material assembly; constructors finalize the index only after
    // clipping beliefs or cutting a service aperture. Opening eligibility uses
    // this unindexed material directly through clear_segments.
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
            index: GeometryIndex::default(),
            blocked_openings,
            partial_knowledge,
            observed_openings,
            service_apertures: Vec::new(),
            disaster: scenario.disaster,
            hazard_areas: scenario
                .disaster
                .map_or_else(Vec::new, |d| crate::models::DisasterState::initial(d).areas),
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

    /// A clear window aperture is available only to its authorized traverser.
    /// Normal navigation and everybody waiting still use intact-wall geometry.
    pub(super) fn with_window_aperture(
        scenario: &'a BuildingScenario,
        emergencies: &'a [Emergency],
        blocked: BTreeSet<String>,
        window: &crate::models::WindowOpening,
    ) -> Self {
        let mut geometry = Self::build(scenario, emergencies, blocked, false, BTreeSet::new());
        let escape = window.emergency_escape.as_ref().unwrap();
        geometry.service_apertures.push(Opening {
            id: window.id.clone(),
            name: None,
            wall_id: window.wall_id.clone(),
            offset: window.offset + (window.width - escape.clear_width_metres) / 2.0,
            width: escape.clear_width_metres,
        });
        geometry.solid_walls = scenario
            .walls
            .iter()
            .enumerate()
            .flat_map(|(index, wall)| {
                geometry
                    .solid_wall_segments(wall)
                    .into_iter()
                    .map(|(a, b)| (a, b, wall.thickness / 2.0, index))
                    .collect::<Vec<_>>()
            })
            .collect();
        geometry.rebuild_index();
        geometry
    }

    fn rebuild_index(&mut self) {
        // Physical bounds contain wall thickness, but never agent radius. A
        // movement query expands its bounds; a vision query remains a ray.
        // Padding also covers the exact rectangle helpers' boundary tolerance.
        let walls = self
            .solid_walls
            .iter()
            .enumerate()
            .map(|(index, &(a, b, half, _))| IndexedPrimitive {
                bounds: Bounds::segment(a, b, half + math::EPSILON),
                primitive: Primitive::Wall(index),
            });
        let obstacles = self
            .obstructions
            .iter()
            .enumerate()
            .map(|(index, obstacle)| IndexedPrimitive {
                bounds: Bounds::segment(
                    Point {
                        x: obstacle.x,
                        y: obstacle.y,
                    },
                    Point {
                        x: obstacle.x + obstacle.width,
                        y: obstacle.y + obstacle.height,
                    },
                    math::EPSILON,
                ),
                primitive: Primitive::Obstruction(index),
            });
        self.index = GeometryIndex::new(walls.chain(obstacles).collect());
    }

    /// Approximate retained heap storage, for bounded immutable belief caches.
    pub(super) fn estimated_size_bytes(&self) -> usize {
        let set_bytes = |set: &BTreeSet<String>| {
            set.iter()
                .map(|s| {
                    s.capacity() + std::mem::size_of::<String>() + 4 * std::mem::size_of::<usize>()
                })
                .sum::<usize>()
        };
        std::mem::size_of::<Self>()
            + self.solid_walls.capacity() * std::mem::size_of::<(Point, Point, f64, usize)>()
            + self.obstructions.capacity() * std::mem::size_of::<&Obstruction>()
            + self.emergencies.capacity() * std::mem::size_of::<Emergency>()
            + self.hazard_areas.capacity() * std::mem::size_of::<crate::models::HazardArea>()
            + self.service_apertures.capacity() * std::mem::size_of::<Opening>()
            + self
                .service_apertures
                .iter()
                .map(|o| {
                    o.id.capacity()
                        + o.wall_id.capacity()
                        + o.name.as_ref().map_or(0, String::capacity)
                })
                .sum::<usize>()
            + set_bytes(&self.blocked_openings)
            + set_bytes(&self.observed_openings)
            + self.index.entries.capacity() * std::mem::size_of::<IndexedPrimitive>()
            + self.index.nodes.capacity() * std::mem::size_of::<BoundsNode>()
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
            if super::control::cancelled() {
                return observed;
            }
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

    /// Sighted or reported danger marks a destination unsafe before a closure
    /// is visible. Gas-covered destinations remain available as a last resort;
    /// the actual opening state controls physical collision geometry.
    pub(super) fn opening_is_unsafe(&self, id: &str) -> bool {
        self.opening_is_blocked(id)
            || self.disaster.is_some()
                && self
                    .scenario
                    .doors
                    .iter()
                    .chain(&self.scenario.exits)
                    .find(|opening| opening.id == id)
                    .is_some_and(|opening| {
                        super::catastrophe::areas_block_opening(
                            self.scenario,
                            opening,
                            &self.hazard_areas,
                        )
                    })
    }

    /// Planning may avoid known danger even though the physics permits escape
    /// from inside it. Someone already exposed can move outward; a route from
    /// outside cannot enter the footprint. This never consults unknown patches.
    pub(super) fn avoids_known_danger(&self, from: Point, to: Point) -> bool {
        self.disaster.is_none_or(|disaster| {
            self.hazard_areas.iter().all(|area| {
                let mut footprint = disaster;
                footprint.radius = area.radius;
                let clearance = footprint.exposure_radius() + self.scenario.agent_radius;
                let initial = math::distance_to_point(from, area.center);
                math::distance_to_segment(area.center, from, to) + math::EPSILON
                    >= clearance.min(initial)
            })
        })
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
        if super::control::cancelled() {
            return false;
        }
        if super::catastrophe::blocks_opening(scenario, opening) {
            return true;
        }
        // Test material with this aperture open, so scheduled reopenings remain
        // possible. Other walls retain their actual openings and rounded caps.
        let mut blocked: BTreeSet<_> = scenario.blocked_exit_ids.iter().cloned().collect();
        blocked.remove(&opening.id);
        let mut layout = Geometry::build(scenario, &[], blocked, false, BTreeSet::new());
        layout.obstructions.clear();
        layout
            .opening_segment(opening)
            .is_some_and(|(start, end)| layout.clear_segments(start, end).is_empty())
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
        !self.index.any(
            Bounds::segment(from, to, 0.0),
            |primitive| match primitive {
                Primitive::Wall(piece) => {
                    let (a, b, thickness, index) = self.solid_walls[piece];
                    !replaced_walls.contains(&index)
                        && math::distance_between_segments(from, to, a, b) <= thickness
                }
                Primitive::Obstruction(index) => {
                    let o = self.obstructions[index];
                    visible_obstruction != Some(o.id.as_str())
                        && math::distance_segment_to_rectangle(
                            from, to, o.x, o.y, o.width, o.height,
                        ) <= 1e-9
                }
            },
        )
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

    pub(super) fn can_see_opening(
        &self,
        from: Point,
        opening: &crate::models::Opening,
        range: f64,
    ) -> bool {
        let (wall_index, wall) = self
            .scenario
            .walls
            .iter()
            .enumerate()
            .find(|(_, wall)| wall.id == opening.wall_id)
            .unwrap();
        let start = math::interpolate(wall.start, wall.end, opening.offset / wall.length());
        let end = math::interpolate(
            wall.start,
            wall.end,
            (opening.offset + opening.width) / wall.length(),
        );
        if range <= 0.0 || math::distance_to_segment(from, start, end) > range {
            return false;
        }
        // Seeing any certified portion is enough to identify the opening's
        // state. The centre can be out of range or behind a narrow screen.
        // Only the closure itself is removed from this visibility query;
        // adjacent material and every intervening barrier remain opaque.
        let revealed: Vec<_> = self
            .scenario
            .walls
            .iter()
            .enumerate()
            .filter(|(index, candidate)| {
                self.opening_is_blocked(&opening.id)
                    && (*index == wall_index
                        || self.covering_wall_gap(candidate, opening).is_some())
            })
            .map(|(index, _)| index)
            .collect();
        let mut occluders: Vec<_> = self
            .solid_walls
            .iter()
            .filter(|(_, _, _, index)| !revealed.contains(index))
            .map(|&(start, end, radius, _)| Occluder::Capsule { start, end, radius })
            .collect();
        for &index in &revealed {
            let wall = &self.scenario.walls[index];
            occluders.extend(
                self.wall_segments_with_visible_opening(wall, Some(&opening.id))
                    .into_iter()
                    .map(|(start, end)| Occluder::Capsule {
                        start,
                        end,
                        radius: wall.thickness / 2.0,
                    }),
            );
        }
        occluders.extend(self.obstructions.iter().map(|o| Occluder::Rectangle {
            x: o.x,
            y: o.y,
            width: o.width,
            height: o.height,
        }));
        !perception::visible_intervals(from, start, end, range, &occluders).is_empty()
    }

    /// Usable centre positions on the exit plane, inset from rounded jambs.
    /// Other obstacles are still checked by can_move/can_stand_at.
    pub(super) fn exit_segment(&self, exit_id: &str) -> Option<(Point, Point)> {
        let gas = self
            .disaster
            .is_some_and(|d| d.kind == crate::models::DisasterKind::GasLeak);
        if self.opening_is_blocked(exit_id) || (!gas && self.opening_is_unsafe(exit_id)) {
            return None;
        }
        let exit = self.scenario.exits.iter().find(|exit| exit.id == exit_id)?;
        self.opening_segment(exit)
    }

    fn opening_segment(&self, exit: &Opening) -> Option<(Point, Point)> {
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

    /// Body-clear intervals on the exit plane, using only this geometry's
    /// material (including remembered fragments when planning with beliefs).
    pub(super) fn exit_segments(&self, exit_id: &str) -> Vec<(Point, Point)> {
        self.exit_segment(exit_id)
            .map_or_else(Vec::new, |(start, end)| self.clear_segments(start, end))
    }

    fn clear_segments(&self, start: Point, end: Point) -> Vec<(Point, Point)> {
        let mut blocked = Vec::new();
        for &(a, b, half_thickness, _) in &self.solid_walls {
            if let Some(interval) = capsule_interval(
                start,
                end,
                a,
                b,
                self.scenario.agent_radius + half_thickness + 1e-6,
            ) {
                blocked.push(interval);
            }
        }
        for obstacle in &self.obstructions {
            if let Some(interval) = box_interval(
                start,
                end,
                Point {
                    x: obstacle.x,
                    y: obstacle.y,
                },
                [
                    (Point { x: 1.0, y: 0.0 }, 0.0, obstacle.width),
                    (Point { x: 0.0, y: 1.0 }, 0.0, obstacle.height),
                ],
            ) {
                blocked.push(interval);
            }
            let vertices = math::rectangle_vertices(
                Point {
                    x: obstacle.x + obstacle.width / 2.0,
                    y: obstacle.y + obstacle.height / 2.0,
                },
                obstacle.width,
                obstacle.height,
                0.0,
            );
            for i in 0..4 {
                if let Some(interval) = capsule_interval(
                    start,
                    end,
                    vertices[i],
                    vertices[(i + 1) % 4],
                    self.scenario.agent_radius + 1e-6,
                ) {
                    blocked.push(interval);
                }
            }
        }
        blocked.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.total_cmp(&b.1)));
        let mut cursor = 0.0_f64;
        let mut clear = Vec::new();
        for (enter, leave) in blocked {
            if enter > cursor {
                clear.push((
                    math::interpolate(start, end, cursor),
                    math::interpolate(start, end, enter),
                ));
            }
            cursor = cursor.max(leave);
        }
        if cursor < 1.0 {
            clear.push((math::interpolate(start, end, cursor), end));
        }
        clear
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
        let tornado = self
            .scenario
            .disaster
            .is_some_and(|d| d.kind == crate::models::DisasterKind::Tornado);
        if tornado
            && self.scenario.tornado_zones.iter().any(|zone| {
                to.x >= zone.x + self.scenario.agent_radius
                    && to.x <= zone.x + zone.width - self.scenario.agent_radius
                    && to.y >= zone.y + self.scenario.agent_radius
                    && to.y <= zone.y + zone.height - self.scenario.agent_radius
            })
            && self.can_move(from, to)
        {
            return None;
        }
        for exit in self.scenario.exits.iter().filter(|_| !tornado) {
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

        // Only material near the body needs exact checks. Available apertures
        // are absent from this index, just as they are from solid_walls.
        !self.index.any(
            Bounds::segment(pos, pos, self.scenario.agent_radius),
            |primitive| match primitive {
                Primitive::Wall(index) => {
                    let (start, end, half_thickness, _) = self.solid_walls[index];
                    math::distance_to_segment(pos, start, end)
                        < self.scenario.agent_radius + half_thickness
                }
                Primitive::Obstruction(index) => {
                    let o = self.obstructions[index];
                    math::distance_to_rectangle(pos, o.x, o.y, o.width, o.height)
                        < self.scenario.agent_radius
                }
            },
        )
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
            .chain(&self.service_apertures)
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
        self.can_move_between_standable(from, to)
    }

    /// Exact swept check for endpoints already verified on this immutable
    /// geometry. Graph construction can reuse each node's standability result.
    pub(super) fn can_move_between_standable(&self, from: Point, to: Point) -> bool {
        if self.emergencies.iter().any(|emergency| {
            math::distance_to_segment(emergency.center, from, to)
                <= emergency.radius + self.scenario.agent_radius
        }) {
            return false;
        }
        !self.index.any(
            Bounds::segment(from, to, self.scenario.agent_radius),
            |primitive| match primitive {
                Primitive::Wall(index) => {
                    let (start, end, half_thickness, _) = self.solid_walls[index];
                    math::distance_between_segments(from, to, start, end)
                        < self.scenario.agent_radius + half_thickness
                }
                Primitive::Obstruction(index) => {
                    let o = self.obstructions[index];
                    math::distance_segment_to_rectangle(from, to, o.x, o.y, o.width, o.height)
                        < self.scenario.agent_radius
                }
            },
        )
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

#[cfg(test)]
mod index_tests {
    use super::*;

    // The pre-index implementation is deliberately retained as an independent
    // oracle: broad-phase rejection must never skip an exact collision.
    fn exhaustive_stand(geometry: &Geometry<'_>, point: Point) -> bool {
        geometry.is_within_workspace(point)
            && !geometry.emergencies.iter().any(|e| {
                math::distance_to_point(point, e.center)
                    <= e.radius + geometry.scenario.agent_radius
            })
            && !geometry.solid_walls.iter().any(|&(a, b, half, _)| {
                math::distance_to_segment(point, a, b) < geometry.scenario.agent_radius + half
            })
            && !geometry.obstructions.iter().any(|o| {
                math::distance_to_rectangle(point, o.x, o.y, o.width, o.height)
                    < geometry.scenario.agent_radius
            })
    }

    fn exhaustive_move(geometry: &Geometry<'_>, from: Point, to: Point) -> bool {
        exhaustive_stand(geometry, from)
            && exhaustive_stand(geometry, to)
            && !geometry.emergencies.iter().any(|e| {
                math::distance_to_segment(e.center, from, to)
                    <= e.radius + geometry.scenario.agent_radius
            })
            && !geometry.solid_walls.iter().any(|&(a, b, half, _)| {
                math::distance_between_segments(from, to, a, b)
                    < geometry.scenario.agent_radius + half
            })
            && !geometry.obstructions.iter().any(|o| {
                math::distance_segment_to_rectangle(from, to, o.x, o.y, o.width, o.height)
                    < geometry.scenario.agent_radius
            })
    }

    fn exhaustive_ray(geometry: &Geometry<'_>, from: Point, to: Point) -> bool {
        !geometry
            .solid_walls
            .iter()
            .any(|&(a, b, half, _)| math::distance_between_segments(from, to, a, b) <= half)
            && !geometry.obstructions.iter().any(|o| {
                math::distance_segment_to_rectangle(from, to, o.x, o.y, o.width, o.height) <= 1e-9
            })
    }

    fn check_queries(geometry: &Geometry<'_>) {
        let mut seed = 419_u64;
        let mut random = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (seed >> 11) as f64 / ((1_u64 << 53) as f64)
        };
        let mut points = vec![Point { x: 0.0, y: 0.0 }, Point { x: -1.0, y: 1.0 }];
        for _ in 0..500 {
            points.push(Point {
                x: random() * geometry.scenario.width,
                y: random() * geometry.scenario.height,
            });
        }
        // Boundary cases exercise caps, tangent bodies, and tiny penetrations.
        for &(start, end, half, _) in &geometry.solid_walls {
            let length = math::distance_to_point(start, end);
            if length <= math::EPSILON {
                continue;
            }
            let middle = math::interpolate(start, end, 0.5);
            let normal = Point {
                x: -(end.y - start.y) / length,
                y: (end.x - start.x) / length,
            };
            for distance in [half, half + geometry.scenario.agent_radius] {
                for delta in [-1e-10, 0.0, 1e-10] {
                    points.push(Point {
                        x: middle.x + normal.x * (distance + delta),
                        y: middle.y + normal.y * (distance + delta),
                    });
                }
            }
        }
        for o in &geometry.obstructions {
            for margin in [0.0, geometry.scenario.agent_radius] {
                for delta in [-1e-10, 0.0, 1e-10] {
                    points.push(Point {
                        x: o.x - margin + delta,
                        y: o.y + o.height / 2.0,
                    });
                }
            }
        }
        for (index, &from) in points.iter().enumerate() {
            assert_eq!(
                geometry.can_stand_at(from),
                exhaustive_stand(geometry, from),
                "stand {from:?}"
            );
            for to in [
                from,
                points[(index * 67 + 11) % points.len()],
                points[(index * 31 + 47) % points.len()],
            ] {
                let expected = exhaustive_move(geometry, from, to);
                assert_eq!(
                    geometry.can_move(from, to),
                    expected,
                    "move {from:?} -> {to:?}"
                );
                if exhaustive_stand(geometry, from) && exhaustive_stand(geometry, to) {
                    assert_eq!(geometry.can_move_between_standable(from, to), expected);
                }
                assert_eq!(
                    geometry.has_line_of_sight(from, to),
                    exhaustive_ray(geometry, from, to),
                    "ray {from:?} -> {to:?}"
                );
            }
        }
    }

    #[test]
    fn index_matches_exhaustive_queries_for_layouts_closures_and_beliefs() {
        for json in [
            include_str!("../../../shared/examples/building.json"),
            include_str!("../../../frontend/src/editor/presets/corporate-office.json"),
        ] {
            let scenario: BuildingScenario = serde_json::from_str(json).unwrap();
            check_queries(&Geometry::new(&scenario));
            let emergencies = [Emergency {
                center: Point {
                    x: scenario.width / 2.0,
                    y: scenario.height / 2.0,
                },
                radius: 0.7,
            }];
            check_queries(&Geometry::with_emergencies(&scenario, &emergencies));
            let blocked = scenario.exits.iter().map(|exit| exit.id.clone()).collect();
            check_queries(&Geometry::with_blocked_openings(&scenario, &[], blocked));
            // Reopening constructs fresh geometry, including fresh broad-phase
            // bounds. Old closure material must not survive in the new index.
            check_queries(&Geometry::with_blocked_openings(
                &scenario,
                &[],
                BTreeSet::new(),
            ));

            let known = scenario
                .walls
                .iter()
                .map(|wall| {
                    (
                        wall.id.clone(),
                        vec![
                            WallSpan {
                                start: 0.0,
                                end: wall.length() / 3.0,
                            },
                            WallSpan {
                                start: wall.length() * 2.0 / 3.0,
                                end: wall.length(),
                            },
                        ],
                    )
                })
                .collect();
            check_queries(&Geometry::for_beliefs(
                &scenario,
                &[],
                BTreeSet::new(),
                &BTreeSet::new(),
                &BTreeSet::new(),
                &BTreeSet::new(),
                &known,
            ));
        }
    }

    #[test]
    fn window_aperture_and_vision_exclusions_keep_matching_exact_geometry() {
        let scenario: BuildingScenario =
            serde_json::from_str(include_str!("../../../shared/examples/window-escape.json"))
                .unwrap();
        let window = scenario
            .windows
            .iter()
            .find(|window| window.emergency_escape.is_some())
            .unwrap();
        let geometry = Geometry::with_window_aperture(&scenario, &[], BTreeSet::new(), window);
        check_queries(&geometry);
        let from = Point {
            x: scenario.width / 2.0,
            y: scenario.height / 2.0,
        };
        for obstacle in &geometry.obstructions {
            let to = Point {
                x: from.x.clamp(obstacle.x, obstacle.x + obstacle.width),
                y: from.y.clamp(obstacle.y, obstacle.y + obstacle.height),
            };
            let expected =
                !geometry.solid_walls.iter().any(|&(a, b, half, _)| {
                    math::distance_between_segments(from, to, a, b) <= half
                }) && !geometry.obstructions.iter().any(|o| {
                    o.id != obstacle.id
                        && math::distance_segment_to_rectangle(
                            from, to, o.x, o.y, o.width, o.height,
                        ) <= 1e-9
                });
            assert_eq!(geometry.can_see_obstruction(from, obstacle), expected);
        }
    }

    #[test]
    fn local_query_prunes_distant_primitives() {
        let entries = (0..100)
            .map(|index| IndexedPrimitive {
                bounds: Bounds::segment(
                    Point {
                        x: index as f64 * 5.0,
                        y: 0.0,
                    },
                    Point {
                        x: index as f64 * 5.0 + 1.0,
                        y: 1.0,
                    },
                    0.0,
                ),
                primitive: Primitive::Wall(index),
            })
            .collect();
        let index = GeometryIndex::new(entries);
        let mut candidates = Vec::new();
        assert!(!index.any(
            Bounds::segment(Point { x: 0.2, y: 0.2 }, Point { x: 0.8, y: 0.8 }, 0.2),
            |primitive| {
                candidates.push(primitive);
                false
            }
        ));
        assert_eq!(candidates.len(), 1);
        assert!(matches!(candidates[0], Primitive::Wall(0)));
    }
}
