use super::{congestion::CrowdForecast, geometry::Geometry, math};
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
    shelter: bool,
}

/// A graph is shared by agents with the same discovered openings and blockers.
pub(super) struct Navigation {
    exits: Vec<ExitTarget>,
    points: Vec<Point>,
    connections: Vec<Vec<Connection>>,
    agent_radius: f64,
}

impl Navigation {
    /// Build for the supplied geometry, which may represent an agent's beliefs.
    pub(super) fn new(scenario: &BuildingScenario, geometry: &Geometry<'_>) -> Self {
        let mut exits: Vec<ExitTarget> = scenario
            .exits
            .iter()
            .filter(|exit| !geometry.opening_is_unsafe(&exit.id))
            .flat_map(|exit| {
                geometry
                    .exit_segments(&exit.id)
                    .into_iter()
                    .map(|(start, end)| ExitTarget {
                        id: exit.id.clone(),
                        start,
                        end,
                        shelter: false,
                    })
            })
            .collect();

        if scenario
            .disaster
            .is_some_and(|d| d.kind == crate::models::DisasterKind::Tornado)
        {
            let r = scenario.agent_radius;
            exits = scenario
                .tornado_zones
                .iter()
                .map(|zone| ExitTarget {
                    id: zone.id.clone(),
                    start: Point {
                        x: zone.x + r,
                        y: zone.y + r,
                    },
                    end: Point {
                        x: zone.x + zone.width - r,
                        y: zone.y + zone.height - r,
                    },
                    shelter: true,
                })
                .collect();
        }
        Self::with_targets(scenario, geometry, exits)
    }

    /// Reuse the same collision-checked visibility graph for an interior approach point.
    pub(super) fn to_point(
        scenario: &BuildingScenario,
        geometry: &Geometry<'_>,
        id: String,
        position: Point,
    ) -> Self {
        Self::with_targets(
            scenario,
            geometry,
            vec![ExitTarget {
                id,
                start: position,
                end: position,
                shelter: false,
            }],
        )
    }

    fn with_targets(
        scenario: &BuildingScenario,
        geometry: &Geometry<'_>,
        exits: Vec<ExitTarget>,
    ) -> Self {
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
            if exit.shelter {
                add_point(Point {
                    x: exit.start.x,
                    y: exit.end.y,
                });
                add_point(Point {
                    x: exit.end.x,
                    y: exit.start.y,
                });
            }
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

        if let Some(disaster) = geometry.disaster {
            // Sample only the outer frontier of overlapping patches. Bound the
            // added graph size as spread grows; these are not physical blockers.
            let mut frontier = Vec::new();
            for area in &geometry.hazard_areas {
                let mut footprint = disaster;
                footprint.radius = area.radius;
                let radius = (footprint.exposure_radius() + scenario.agent_radius + 1e-4)
                    / (std::f64::consts::PI / 16.0).cos();
                for i in 0..16 {
                    let angle = std::f64::consts::TAU * i as f64 / 16.0;
                    let point = Point {
                        x: area.center.x + radius * angle.cos(),
                        y: area.center.y + radius * angle.sin(),
                    };
                    if !geometry.hazard_areas.iter().any(|other| {
                        let mut footprint = disaster;
                        footprint.radius = other.radius;
                        math::distance_to_point(point, other.center)
                            < footprint.exposure_radius() + scenario.agent_radius
                    }) {
                        frontier.push(point);
                    }
                }
            }
            let stride = frontier.len().div_ceil(64).max(1);
            for point in frontier.into_iter().step_by(stride) {
                add_point(point);
            }
        }

        let mut connections: Vec<Vec<Connection>> = (0..points.len()).map(|_| Vec::new()).collect();
        for a in 0..points.len() {
            for b in a + 1..points.len() {
                if super::control::cancelled() {
                    break;
                }
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
            agent_radius: scenario.agent_radius,
        }
    }

    /// Shortest route through the sampled visibility graph. None means no
    /// route was found with these waypoints, not proof of physical entrapment.
    /// Use the same unchanged scenario for this graph and the supplied Geometry.
    pub(super) fn find_route(&self, from: Point, geometry: &Geometry<'_>) -> Option<Route> {
        self.find_route_with_forecast(
            from,
            geometry,
            &CrowdForecast::for_geometry(geometry),
            self.agent_radius,
        )
    }

    #[cfg(test)]
    pub(super) fn find_route_with_crowd(
        &self,
        from: Point,
        geometry: &Geometry<'_>,
        occupants: &[Point],
        radius: f64,
    ) -> Option<Route> {
        self.find_route_with_forecast(
            from,
            geometry,
            &CrowdForecast::stationary(occupants),
            radius,
        )
    }

    /// Forecast congestion changes routing costs, never physical geometry.
    pub(super) fn find_route_with_forecast(
        &self,
        from: Point,
        geometry: &Geometry<'_>,
        occupants: &CrowdForecast,
        radius: f64,
    ) -> Option<Route> {
        self.search(from, geometry, occupants, radius, false)
    }

    /// Search the same graph with known hazard crossings excluded. Failure is
    /// a reason to try a window, not proof that the occupant is trapped.
    pub(super) fn find_route_avoiding_danger(
        &self,
        from: Point,
        geometry: &Geometry<'_>,
    ) -> Option<Route> {
        self.find_safe_route_with_forecast(
            from,
            geometry,
            &CrowdForecast::for_geometry(geometry),
            self.agent_radius,
        )
    }

    pub(super) fn find_safe_route_with_forecast(
        &self,
        from: Point,
        geometry: &Geometry<'_>,
        occupants: &CrowdForecast,
        radius: f64,
    ) -> Option<Route> {
        self.search(from, geometry, occupants, radius, true)
    }

    fn search(
        &self,
        from: Point,
        geometry: &Geometry<'_>,
        occupants: &CrowdForecast,
        radius: f64,
        avoid_danger: bool,
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
            if geometry.can_move(from, point)
                && (!avoid_danger || geometry.avoids_known_danger(from, point))
            {
                let distance =
                    math::distance_to_point(from, point) + occupants.cost(from, point, radius);
                distances[node] = distance;
                queue.push(SearchState { node, distance });
            }
        }

        // Each graph node can finish at its closest point on an exit segment,
        // rather than funnelling every person through one fixed graph target.
        let mut best: Option<(f64, usize, Point, Option<usize>)> = None;
        let mut consider = |start: Point, distance: f64, parent: Option<usize>| {
            for (index, exit) in self.exits.iter().enumerate() {
                let target = if exit.shelter {
                    Point {
                        x: start.x.clamp(exit.start.x, exit.end.x),
                        y: start.y.clamp(exit.start.y, exit.end.y),
                    }
                } else {
                    math::closest_point_on_segment(start, exit.start, exit.end)
                };
                if geometry.can_move(start, target)
                    && (!avoid_danger || geometry.avoids_known_danger(start, target))
                {
                    let cost = distance
                        + math::distance_to_point(start, target)
                        + occupants.cost(start, target, radius);
                    if best.as_ref().is_none_or(|&(current, ..)| cost < current) {
                        best = Some((cost, index, target, parent));
                    }
                }
            }
            best.as_ref().map_or(f64::INFINITY, |&(cost, ..)| cost)
        };
        let mut best_cost = consider(from, 0.0, None);
        while let Some(SearchState { node, distance }) = queue.pop() {
            if super::control::cancelled() {
                return None;
            }
            if distance > distances[node] {
                continue;
            }
            if distance > best_cost {
                break;
            }
            best_cost = consider(self.points[node], distance, Some(node));
            for edge in &self.connections[node] {
                if avoid_danger
                    && !geometry.avoids_known_danger(self.points[node], self.points[edge.to])
                {
                    continue;
                }
                let candidate = distance
                    + edge.distance
                    + occupants.cost(self.points[node], self.points[edge.to], radius);
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

#[cfg(test)]
pub(super) fn crowd_cost(start: Point, end: Point, occupants: &[Point], radius: f64) -> f64 {
    CrowdForecast::stationary(occupants).cost(start, end, radius)
}

pub(super) fn route_cost(
    from: Point,
    waypoints: &[Point],
    occupants: &CrowdForecast,
    radius: f64,
) -> f64 {
    let mut start = from;
    waypoints
        .iter()
        .map(|&end| {
            let cost = math::distance_to_point(start, end) + occupants.cost(start, end, radius);
            start = end;
            cost
        })
        .sum()
}

/// Require a material saving before changing guidance, to reduce oscillation
/// as nearby people move. An unavailable alternative leaves the route intact.
pub(super) fn materially_better(candidate: f64, current: f64, radius: f64) -> bool {
    candidate + (current * 0.12).max(2.0 * radius) < current
}
