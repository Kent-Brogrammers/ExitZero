use super::{congestion::CrowdForecast, geometry::Geometry, math};
use crate::models::{BuildingScenario, Point};
use std::{cell::OnceCell, cmp::Ordering, collections::BinaryHeap, sync::Arc};

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
    /// A gas crossing accepted only after a search for a clear route failed.
    pub risk_allowed: bool,
    pub exit_id: String,
    pub waypoints: Vec<Point>,
}

struct ExitTarget {
    id: String,
    start: Point,
    end: Point,
    shelter: bool,
}

struct VisibilityGraph {
    points: Vec<Point>,
    connections: Vec<Vec<Connection>>,
    agent_radius: f64,
}

struct GoalConnection {
    exit: usize,
    target: Point,
    distance: f64,
    safe: bool,
}

/// Destinations and their lazy terminal connectors belong to a query, so a
/// moving target never reconstructs the collision-checked visibility graph.
struct GoalSet {
    exits: Vec<ExitTarget>,
    connections: Vec<OnceCell<Vec<GoalConnection>>>,
}

impl GoalSet {
    fn connect(&self, from: Point, geometry: &Geometry<'_>) -> Vec<GoalConnection> {
        self.exits
            .iter()
            .enumerate()
            .filter_map(|(exit, goal)| {
                let target = if goal.shelter {
                    Point {
                        x: from.x.clamp(goal.start.x, goal.end.x),
                        y: from.y.clamp(goal.start.y, goal.end.y),
                    }
                } else {
                    math::closest_point_on_segment(from, goal.start, goal.end)
                };
                geometry.can_move(from, target).then(|| GoalConnection {
                    exit,
                    target,
                    distance: math::distance_to_point(from, target),
                    safe: !geometry.opening_is_unsafe(&goal.id)
                        && geometry.avoids_known_danger(from, target),
                })
            })
            .collect()
    }
}

/// Graphs are shared only for unchanged geometry, including an agent's beliefs.
pub(super) struct Navigation {
    graph: Arc<VisibilityGraph>,
    goals: GoalSet,
}

impl Navigation {
    /// Build for the supplied geometry, which may represent an agent's beliefs.
    pub(super) fn new(scenario: &BuildingScenario, geometry: &Geometry<'_>) -> Self {
        let mut exits: Vec<ExitTarget> = scenario
            .exits
            .iter()
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
        let graph = Arc::new(VisibilityGraph::new(scenario, geometry, &exits));
        Self::with_goals(graph, exits)
    }

    fn with_goals(graph: Arc<VisibilityGraph>, exits: Vec<ExitTarget>) -> Self {
        let connections = (0..graph.points.len()).map(|_| OnceCell::new()).collect();
        Self {
            graph,
            goals: GoalSet { exits, connections },
        }
    }

    /// Connect a point target to this graph at query time. Rebuild this base
    /// navigation only when its geometry changes, not when the target moves.
    pub(super) fn with_point_target(&self, id: String, position: Point) -> Self {
        Self::with_goals(
            Arc::clone(&self.graph),
            vec![ExitTarget {
                id,
                start: position,
                end: position,
                shelter: false,
            }],
        )
    }

    /// Conservative cache accounting. Shared graphs may be counted more than
    /// once; undercounting retained edge buffers would defeat the cache budget.
    pub(super) fn estimated_size_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.graph.points.capacity() * std::mem::size_of::<Point>()
            + self.graph.connections.capacity() * std::mem::size_of::<Vec<Connection>>()
            + self
                .graph
                .connections
                .iter()
                .map(|edges| edges.capacity() * std::mem::size_of::<Connection>())
                .sum::<usize>()
            + self.goals.exits.capacity() * std::mem::size_of::<ExitTarget>()
            + self
                .goals
                .exits
                .iter()
                .map(|exit| exit.id.capacity())
                .sum::<usize>()
            + self.goals.connections.capacity()
                * std::mem::size_of::<OnceCell<Vec<GoalConnection>>>()
            // Reserve the eventual lazy connector buffers up front. Cache
            // accounting must not shrink merely because a node is unvisited.
            + self.goals.connections.len()
                * if self.goals.exits.is_empty() {
                    0
                } else {
                    self.goals.exits.len().max(4).next_power_of_two()
                        * std::mem::size_of::<GoalConnection>()
                }
    }
}

impl VisibilityGraph {
    fn new(scenario: &BuildingScenario, geometry: &Geometry<'_>, landmarks: &[ExitTarget]) -> Self {
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
        for exit in landmarks {
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
                if geometry.can_move_between_standable(points[a], points[b]) {
                    let distance = math::distance_to_point(points[a], points[b]);
                    connections[a].push(Connection { to: b, distance });
                    connections[b].push(Connection { to: a, distance });
                }
            }
        }

        Self {
            points,
            connections,
            agent_radius: scenario.agent_radius,
        }
    }
}

impl Navigation {
    /// Shortest route through the sampled visibility graph. None means no
    /// route was found with these waypoints, not proof of physical entrapment.
    /// Use the same unchanged scenario for this graph and the supplied Geometry.
    pub(super) fn find_route(&self, from: Point, geometry: &Geometry<'_>) -> Option<Route> {
        self.find_route_with_forecast(
            from,
            geometry,
            &CrowdForecast::for_geometry(geometry),
            self.graph.agent_radius,
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
        // Prefer a danger-free gas route before accepting exposure as a last
        // resort. Physically blocked exits remain absent from the graph.
        if geometry
            .disaster
            .is_some_and(|d| d.kind == crate::models::DisasterKind::GasLeak)
            && let Some(route) = self.search(from, geometry, occupants, radius, true)
        {
            return Some(route);
        }
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
            self.graph.agent_radius,
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
        if self.goals.exits.is_empty() || !geometry.can_stand_at(from) {
            return None;
        }
        let mut distances = vec![f64::INFINITY; self.graph.points.len()];
        let mut previous = vec![None; self.graph.points.len()];
        let mut queue = BinaryHeap::new();

        // Treat the agent position as a temporary node connected to every
        // visible waypoint. The shared graph itself stays unchanged.
        for (node, &point) in self.graph.points.iter().enumerate() {
            if geometry.can_move_between_standable(from, point)
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
        let direct_connections = self.goals.connect(from, geometry);
        let mut consider = |start: Point, distance: f64, parent: Option<usize>| {
            let connections = match parent {
                Some(node) => {
                    self.goals.connections[node].get_or_init(|| self.goals.connect(start, geometry))
                }
                None => &direct_connections,
            };
            for edge in connections {
                if avoid_danger && !edge.safe {
                    continue;
                }
                let cost = distance + edge.distance + occupants.cost(start, edge.target, radius);
                if best.as_ref().is_none_or(|&(current, ..)| cost < current) {
                    best = Some((cost, edge.exit, edge.target, parent));
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
            best_cost = consider(self.graph.points[node], distance, Some(node));
            for edge in &self.graph.connections[node] {
                if avoid_danger
                    && !geometry
                        .avoids_known_danger(self.graph.points[node], self.graph.points[edge.to])
                {
                    continue;
                }
                let candidate = distance
                    + edge.distance
                    + occupants.cost(self.graph.points[node], self.graph.points[edge.to], radius);
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
            if math::distance_to_point(*waypoints.last().unwrap(), self.graph.points[node])
                > math::EPSILON
            {
                waypoints.push(self.graph.points[node]);
            }
            cursor = previous[node];
        }
        waypoints.reverse();
        Some(Route {
            risk_allowed: !avoid_danger
                && geometry
                    .disaster
                    .is_some_and(|d| d.kind == crate::models::DisasterKind::GasLeak),
            exit_id: self.goals.exits[index].id.clone(),
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

#[cfg(test)]
mod reuse_tests {
    use super::*;

    fn scenario() -> BuildingScenario {
        serde_json::from_str(include_str!("../../../shared/examples/building.json")).unwrap()
    }

    fn assert_clear_route(from: Point, route: &Route, target: Point, geometry: &Geometry<'_>) {
        let mut start = from;
        for &end in &route.waypoints {
            assert!(geometry.can_move(start, end), "{start:?} -> {end:?}");
            start = end;
        }
        assert!(math::distance_to_point(start, target) <= math::EPSILON);
    }

    #[test]
    fn moving_point_targets_reuse_topology_and_keep_exact_collision_checks() {
        let scenario = scenario();
        let geometry = Geometry::new(&scenario);
        let navigation = Navigation::new(&scenario, &geometry);
        let from = Point { x: 5.0, y: 5.0 };
        for target in [Point { x: 8.0, y: 5.0 }, Point { x: 22.0, y: 15.0 }] {
            let point_navigation = navigation.with_point_target("moving".into(), target);
            assert!(Arc::ptr_eq(&navigation.graph, &point_navigation.graph));
            let route = point_navigation.find_route(from, &geometry).unwrap();
            assert_eq!(route.exit_id, "moving");
            assert_clear_route(from, &route, target, &geometry);
        }
        // A target inside solid material never becomes an unchecked connector.
        let wall = &scenario.walls[0];
        let blocked = math::interpolate(wall.start, wall.end, 0.5);
        assert!(!geometry.can_stand_at(blocked));
        assert!(
            navigation
                .with_point_target("blocked".into(), blocked)
                .find_route(from, &geometry)
                .is_none()
        );
    }

    #[test]
    fn cached_terminal_geometry_does_not_cache_observers_crowd_costs() {
        let scenario = scenario();
        let geometry = Geometry::new(&scenario);
        let navigation = Navigation::new(&scenario, &geometry);
        let from = Point { x: 5.0, y: 5.0 };
        let queue = [Point { x: 4.0, y: 5.0 }, Point { x: 3.0, y: 5.0 }];
        let before = navigation.estimated_size_bytes();
        for people in [&[][..], &queue[..], &[][..]] {
            let forecast = CrowdForecast::stationary(people);
            let cached = navigation
                .find_route_with_forecast(from, &geometry, &forecast, scenario.agent_radius)
                .unwrap();
            let fresh = Navigation::new(&scenario, &geometry)
                .find_route_with_forecast(from, &geometry, &forecast, scenario.agent_radius)
                .unwrap();
            assert_eq!(cached.exit_id, fresh.exit_id);
            assert_eq!(
                route_cost(from, &cached.waypoints, &forecast, scenario.agent_radius),
                route_cost(from, &fresh.waypoints, &forecast, scenario.agent_radius)
            );
        }
        assert!(
            navigation
                .goals
                .connections
                .iter()
                .any(|cell| cell.get().is_some())
        );
        assert_eq!(
            before,
            navigation.estimated_size_bytes(),
            "lazy buffers are budgeted up front"
        );
    }

    #[test]
    fn retargeting_does_not_reuse_previous_goal_connectors() {
        let scenario = scenario();
        let geometry = Geometry::new(&scenario);
        let navigation = Navigation::new(&scenario, &geometry);
        let from = Point { x: 5.0, y: 5.0 };
        let first = navigation.with_point_target("first".into(), Point { x: 8.0, y: 5.0 });
        first.find_route(from, &geometry).unwrap();
        let target = Point { x: 22.0, y: 15.0 };
        let second = first.with_point_target("second".into(), target);
        assert!(Arc::ptr_eq(&first.graph, &second.graph));
        let route = second.find_route(from, &geometry).unwrap();
        assert_eq!(route.exit_id, "second");
        assert_clear_route(from, &route, target, &geometry);
    }

    #[test]
    fn reused_point_graph_matches_or_improves_original_point_specific_routes() {
        for json in [
            include_str!("../../../shared/examples/building.json"),
            include_str!("../../../frontend/src/editor/presets/corporate-office.json"),
            include_str!("../../../frontend/src/editor/presets/halloween-pursuit.json"),
        ] {
            let scenario: BuildingScenario = serde_json::from_str(json).unwrap();
            let geometry = Geometry::new(&scenario);
            let navigation = Navigation::new(&scenario, &geometry);
            let mut agents = Vec::new();
            super::super::agent::spawn_agents(&mut agents, &scenario, &geometry).unwrap();
            let from = agents[0].position;
            let target = agents.last().unwrap().position;
            // Reproduce the old to_point topology, including its target-first
            // node order, as an independent sampled-route comparison.
            let goal = ExitTarget {
                id: "target".into(),
                start: target,
                end: target,
                shelter: false,
            };
            let original = Navigation::with_goals(
                Arc::new(VisibilityGraph::new(
                    &scenario,
                    &geometry,
                    std::slice::from_ref(&goal),
                )),
                vec![goal],
            );
            let reused = navigation.with_point_target("target".into(), target);
            let crowd = [agents[agents.len() / 2].position];
            for people in [&[][..], &crowd[..]] {
                let forecast = CrowdForecast::stationary(people);
                let old_route = original
                    .find_route_with_forecast(from, &geometry, &forecast, scenario.agent_radius)
                    .unwrap();
                let new_route = reused
                    .find_route_with_forecast(from, &geometry, &forecast, scenario.agent_radius)
                    .unwrap();
                assert_clear_route(from, &new_route, target, &geometry);
                let cost = |route: &Route| {
                    route_cost(from, &route.waypoints, &forecast, scenario.agent_radius)
                };
                assert!(
                    cost(&new_route) <= cost(&old_route) + 1e-8,
                    "reused graph cost {} exceeds old cost {}",
                    cost(&new_route),
                    cost(&old_route)
                );
            }
        }
    }
}
