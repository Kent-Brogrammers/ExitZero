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

/// A route ends at the centre of its exit opening. Reaching this target is
/// a navigation result; the simulation must define when to count evacuation.
pub(super) struct Route {
    pub exit_id: String,
    pub waypoints: Vec<Point>,
}

struct ExitTarget {
    id: String,
    position: Point,
}

/// A graph is shared by agents with the same discovered openings and blockers.
pub(super) struct Navigation {
    exits: Vec<ExitTarget>,
    points: Vec<Point>,
    connections: Vec<Vec<Connection>>,
    exit_nodes: Vec<Option<usize>>,
}

impl Navigation {
    /// Build for the supplied geometry, which may represent an agent's beliefs.
    pub(super) fn new(scenario: &BuildingScenario, geometry: &Geometry<'_>) -> Self {
        let exits: Vec<ExitTarget> = scenario
            .exits
            .iter()
            .filter(|exit| !geometry.opening_is_blocked(&exit.id))
            .filter_map(|exit| {
                let wall = scenario.walls.iter().find(|wall| wall.id == exit.wall_id)?;
                let length = wall.length();
                if length <= 0.0 {
                    return None;
                }

                let t = (exit.offset + exit.width / 2.0) / length;
                Some(ExitTarget {
                    id: exit.id.clone(),
                    position: math::interpolate(wall.start, wall.end, t),
                })
            })
            .collect();

        let mut points = Vec::new();
        let mut exit_nodes = Vec::new();
        for (index, exit) in exits.iter().enumerate() {
            if geometry.can_stand_at(exit.position) {
                points.push(exit.position);
                exit_nodes.push(Some(index));
            }
        }

        let mut add_point = |point: Point| {
            if geometry.can_stand_at(point)
                && !points
                    .iter()
                    .any(|&existing| math::distance_to_point(existing, point) <= math::EPSILON)
            {
                points.push(point);
                exit_nodes.push(None);
            }
        };

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
            exit_nodes,
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

        while let Some(SearchState { node, distance }) = queue.pop() {
            if distance > distances[node] {
                continue;
            }
            if let Some(exit_index) = self.exit_nodes[node] {
                let mut waypoints = vec![self.points[node]];
                let mut cursor = node;
                while let Some(parent) = previous[cursor] {
                    waypoints.push(self.points[parent]);
                    cursor = parent;
                }
                waypoints.reverse();
                return Some(Route {
                    exit_id: self.exits[exit_index].id.clone(),
                    waypoints,
                });
            }
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
        None
    }
}

fn crowd_cost(start: Point, end: Point, occupants: &[Point], radius: f64) -> f64 {
    occupants
        .iter()
        .filter(|&&position| math::distance_to_segment(position, start, end) < 4.0 * radius)
        .count() as f64
        * (8.0 * radius)
}
