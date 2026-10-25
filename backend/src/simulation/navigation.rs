use super::{geometry::Geometry, math};
use crate::models::{BuildingScenario, Point};
use std::{cmp::Ordering, collections::BinaryHeap};

struct Connection {
    to: usize,
    distance: f64,
}

#[derive(Clone, Copy)]
struct SearchState {
    node: usize,
    distance: f64,
}

impl PartialEq for SearchState {
    fn eq(&self, other: &Self) -> bool {
        self.node == other.node && self.distance.total_cmp(&other.distance) == Ordering::Equal
    }
}
impl Eq for SearchState {}
impl PartialOrd for SearchState {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for SearchState {
    fn cmp(&self, other: &Self) -> Ordering {
        // BinaryHeap is a max heap; reverse cost for shortest-first expansion.
        other
            .distance
            .total_cmp(&self.distance)
            .then_with(|| other.node.cmp(&self.node))
    }
}

/// A route ends at a body-clear position anywhere along its exit opening.
pub(super) struct Route {
    pub exit_id: String,
    pub waypoints: Vec<Point>,
}

struct ExitTarget {
    id: String,
    start: Point,
    end: Point,
}

/// A graph is shared by agents with the same discovered openings and blockers.
pub(super) struct Navigation {
    exits: Vec<ExitTarget>,
    points: Vec<Point>,
    connections: Vec<Vec<Connection>>,
}

impl Navigation {
    /// Build for the supplied geometry, which may represent an agent's beliefs.
    pub(super) fn new(scenario: &BuildingScenario, geometry: &Geometry<'_>) -> Self {
        let exits: Vec<ExitTarget> = scenario
            .exits
            .iter()
            .filter(|exit| !geometry.opening_is_blocked(&exit.id))
            .filter_map(|exit| {
                let (start, end) = geometry.exit_segment(&exit.id)?;
                Some(ExitTarget {
                    id: exit.id.clone(),
                    start,
                    end,
                })
            })
            .collect();

        let mut points = Vec::new();
        let mut add_point = |point: Point| {
            if geometry.can_stand_at(point)
                && !points
                    .iter()
                    .any(|&existing| math::distance_to_point(existing, point) <= math::EPSILON)
            {
                points.push(point);
            }
        };

        // Endpoints and centres also provide fallbacks when another obstacle
        // hides the perpendicular approach to part of an exit.
        for exit in &exits {
            add_point(exit.start);
            add_point(exit.end);
            add_point(math::interpolate(exit.start, exit.end, 0.5));
        }

        // Only remembered fragments supply endpoints. A frontier of observed
        // space is a tentative detour, not knowledge of a hidden wall's end.
        for (start, end, half_thickness) in geometry.wall_fragments() {
            let length = math::distance_to_point(start, end);
            let tangent = if length <= math::EPSILON {
                Point { x: 1.0, y: 0.0 }
            } else {
                Point {
                    x: (end.x - start.x) / length,
                    y: (end.y - start.y) / length,
                }
            };
            let normal = Point {
                x: -tangent.y,
                y: tangent.x,
            };
            let clearance = scenario.agent_radius + half_thickness + 1e-6;
            for (endpoint, direction) in [(start, -1.0), (end, 1.0)] {
                for side in [-1.0, 1.0] {
                    add_point(Point {
                        x: endpoint.x + clearance * (direction * tangent.x + side * normal.x),
                        y: endpoint.y + clearance * (direction * tangent.y + side * normal.y),
                    });
                }
            }
        }
        for opening in scenario
            .doors
            .iter()
            .chain(&scenario.exits)
            .filter(|opening| {
                !geometry.opening_is_blocked(&opening.id)
                    && geometry.opening_was_observed(&opening.id)
            })
        {
            let wall = scenario
                .walls
                .iter()
                .find(|wall| wall.id == opening.wall_id)
                .unwrap();
            let length = wall.length();
            let normal = Point {
                x: -(wall.end.y - wall.start.y) / length,
                y: (wall.end.x - wall.start.x) / length,
            };
            let center = math::interpolate(
                wall.start,
                wall.end,
                (opening.offset + opening.width / 2.0) / length,
            );
            let clearance = scenario.agent_radius + wall.thickness / 2.0 + 1e-6;
            add_point(center);
            for side in [-1.0, 1.0] {
                add_point(Point {
                    x: center.x + side * clearance * normal.x,
                    y: center.y + side * clearance * normal.y,
                });
            }
        }

        for obstacle in geometry.obstructions() {
            let margin = scenario.agent_radius + 1e-6;
            for x in [obstacle.x - margin, obstacle.x + obstacle.width + margin] {
                for y in [obstacle.y - margin, obstacle.y + obstacle.height + margin] {
                    add_point(Point { x, y });
                }
            }
        }

        // Circumscribed rings supply safe detours around circular danger zones.
        // Adjacent ring vertices connect outside the full exclusion radius.
        const RING_POINTS: usize = 16;
        for emergency in geometry.emergencies() {
            let radius = (emergency.radius + scenario.agent_radius + 1e-6)
                / (std::f64::consts::PI / RING_POINTS as f64).cos();
            for i in 0..RING_POINTS {
                let angle = std::f64::consts::TAU * i as f64 / RING_POINTS as f64;
                add_point(Point {
                    x: emergency.center.x + radius * angle.cos(),
                    y: emergency.center.y + radius * angle.sin(),
                });
            }
        }

        let mut connections: Vec<Vec<Connection>> = (0..points.len()).map(|_| Vec::new()).collect();
        for a in 0..points.len() {
            for b in a + 1..points.len() {
                if geometry.can_move(points[a], points[b]) {
                    let distance = math::distance_to_point(points[a], points[b]);
                    connections[a].push(Connection { to: b, distance });
                    connections[b].push(Connection { to: a, distance });
                }
            }
        }

        Self {
            exits,
            points,
            connections,
        }
    }

    /// Shortest route through the sampled visibility graph. None means no
    /// route was found with these waypoints, not proof of physical entrapment.
    /// Use the same unchanged scenario for this graph and the supplied Geometry.
    pub(super) fn find_route(&self, from: Point, geometry: &Geometry<'_>) -> Option<Route> {
        self.find_route_with_crowd(from, geometry, &[], 0.0)
    }

    /// Congestion adds a routing cost, never permits crossing physical geometry.
    /// Actual disc collision checks are still required at every movement tick.
    pub(super) fn find_route_with_crowd(
        &self,
        from: Point,
        geometry: &Geometry<'_>,
        occupants: &[Point],
        radius: f64,
    ) -> Option<Route> {
        if !geometry.can_stand_at(from) {
            return None;
        }
        let mut distances = vec![f64::INFINITY; self.points.len()];
        let mut previous = vec![None; self.points.len()];
        let mut queue = BinaryHeap::new();

        // Treat the agent position as a temporary node connected to every
        // visible waypoint. The shared graph itself stays unchanged.
        for (node, &point) in self.points.iter().enumerate() {
            if geometry.can_move(from, point) {
                let distance = math::distance_to_point(from, point)
                    + crowd_cost(from, point, occupants, radius);
                distances[node] = distance;
                queue.push(SearchState { node, distance });
            }
        }

        // Each graph node can finish at its closest point on an exit segment,
        // rather than funnelling every person through one fixed graph target.
        let mut best: Option<(f64, usize, Point, Option<usize>)> = None;
        let mut consider = |start: Point, distance: f64, parent: Option<usize>| {
            for (index, exit) in self.exits.iter().enumerate() {
                let target = math::closest_point_on_segment(start, exit.start, exit.end);
                if geometry.can_move(start, target) {
                    let cost = distance
                        + math::distance_to_point(start, target)
                        + crowd_cost(start, target, occupants, radius);
                    if best.as_ref().is_none_or(|&(current, ..)| cost < current) {
                        best = Some((cost, index, target, parent));
                    }
                }
            }
            best.as_ref().map_or(f64::INFINITY, |&(cost, ..)| cost)
        };
        let mut best_cost = consider(from, 0.0, None);
        while let Some(SearchState { node, distance }) = queue.pop() {
            if distance > distances[node] {
                continue;
            }
            if distance > best_cost {
                break;
            }
            best_cost = consider(self.points[node], distance, Some(node));
            for edge in &self.connections[node] {
                let candidate = distance
                    + edge.distance
                    + crowd_cost(self.points[node], self.points[edge.to], occupants, radius);
                if candidate < distances[edge.to] {
                    distances[edge.to] = candidate;
                    previous[edge.to] = Some(node);
                    queue.push(SearchState {
                        node: edge.to,
                        distance: candidate,
                    });
                }
            }
        }
        let (_, index, target, mut cursor) = best?;
        let mut waypoints = vec![target];
        while let Some(node) = cursor {
            if math::distance_to_point(*waypoints.last().unwrap(), self.points[node])
                > math::EPSILON
            {
                waypoints.push(self.points[node]);
            }
            cursor = previous[node];
        }
        waypoints.reverse();
        Some(Route {
            exit_id: self.exits[index].id.clone(),
            waypoints,
        })
    }
}

/// Integrate local occupancy along a segment. Splitting an edge into waypoints
/// must not change its penalty or create artificial shortcuts through a queue.
pub(super) fn crowd_cost(start: Point, end: Point, occupants: &[Point], radius: f64) -> f64 {
    let length = math::distance_to_point(start, end);
    if length <= math::EPSILON || radius <= 0.0 {
        return 0.0;
    }
    let dx = (end.x - start.x) / length;
    let dy = (end.y - start.y) / length;
    let influence = 4.0 * radius;
    occupants
        .iter()
        .map(|position| {
            let x = position.x - start.x;
            let y = position.y - start.y;
            let along = x * dx + y * dy;
            let across = x * dy - y * dx;
            let half_squared = influence * influence - across * across;
            if half_squared <= 0.0 {
                return 0.0;
            }
            let half = half_squared.sqrt();
            ((along + half).min(length) - (along - half).max(0.0)).max(0.0) * 2.0
        })
        .sum()
}

pub(super) fn route_cost(
    from: Point,
    waypoints: &[Point],
    occupants: &[Point],
    radius: f64,
) -> f64 {
    let mut start = from;
    waypoints
        .iter()
        .map(|&end| {
            let cost =
                math::distance_to_point(start, end) + crowd_cost(start, end, occupants, radius);
            start = end;
            cost
        })
        .sum()
}

/// Require a material saving before changing guidance, to reduce oscillation
/// as nearby people move. An unavailable alternative leaves the route intact.
pub(super) fn materially_better(candidate: f64, current: f64, radius: f64) -> bool {
    candidate + (current * 0.15).max(2.0 * radius) < current
}
