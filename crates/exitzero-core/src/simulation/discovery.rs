//! Estimates and exploration use personal beliefs, never the hidden layout.
use super::perception::Occluder;
use super::{
    agent::Agent,
    congestion::CrowdForecast,
    geometry::Geometry,
    math,
    navigation::{self, Navigation, Route},
};
use crate::models::{BuildingScenario, Point};
use std::{cell::RefCell, collections::BTreeMap, sync::Arc};

/// A repeatable prior for unobserved detours. It changes expected travel cost,
/// not physical geometry, and never fabricates a successful route.
pub(super) struct Outlook {
    origin: Point,
    enabled: bool,
    occluders: Arc<[Occluder]>,
    costs: RefCell<BTreeMap<[u64; 4], f64>>,
    visible: RefCell<BTreeMap<[u64; 2], bool>>,
    phase: [f64; 2],
}

pub(super) fn sample(seed: u64, agent: u32, salt: u64) -> f64 {
    let mut n = seed ^ u64::from(agent).wrapping_mul(0x9e3779b97f4a7c15) ^ salt;
    n = (n ^ (n >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    n = (n ^ (n >> 27)).wrapping_mul(0x94d049bb133111eb);
    ((n ^ (n >> 31)) >> 11) as f64 / 9_007_199_254_740_992.0
}

impl Outlook {
    pub(super) fn new(scenario: &BuildingScenario, agent: &Agent, geometry: &Geometry<'_>) -> Self {
        Self {
            origin: agent.position,
            enabled: scenario.awareness.visibility_range() > 0.0,
            occluders: geometry.visibility_occluders(),
            costs: RefCell::new(BTreeMap::new()),
            visible: RefCell::new(BTreeMap::new()),
            phase: [
                sample(scenario.seed, agent.id, 1),
                sample(scenario.seed, agent.id, 2),
            ]
            .map(|n| n * std::f64::consts::TAU),
        }
    }

    fn point_visible(&self, p: Point) -> bool {
        if !self.enabled {
            return false;
        }
        let key = [p.x.to_bits(), p.y.to_bits()];
        if let Some(visible) = self.visible.borrow().get(&key) {
            return *visible;
        }
        let visible = !self.occluders.iter().any(|&o| o.blocks_ray(self.origin, p));
        if self.visible.borrow().len() < 2048 {
            self.visible.borrow_mut().insert(key, visible);
        }
        visible
    }

    /// Estimate occluded travel cost using ray samples and a smooth detour prior.
    /// Unknown edges can have different expected detours in different directions;
    /// one straight-line distance or a fresh random draw per tick cannot do that.
    pub(super) fn cost(&self, a: Point, b: Point) -> f64 {
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let squared = dx * dx + dy * dy;
        if squared <= math::EPSILON * math::EPSILON {
            return 0.0;
        }
        let key = [a.x.to_bits(), a.y.to_bits(), b.x.to_bits(), b.y.to_bits()];
        if let Some(cost) = self.costs.borrow().get(&key) {
            return *cost;
        }
        let hidden = |p| if self.point_visible(p) { 0.0 } else { 1.0 };
        // This is an uncertainty estimate, not the visibility algorithm.
        // Reuse point raycasts across graph edges instead of rebuilding full
        // visibility intervals for every Dijkstra relaxation.
        let uncertainty =
            (hidden(a) + 2.0 * hidden(math::interpolate(a, b, 0.5)) + hidden(b)) / 4.0;
        let mean_sin = |u: f64, v: f64| {
            if (v - u).abs() < 1e-5 {
                ((u + v) * 0.5).sin()
            } else {
                (u.cos() - v.cos()) / (v - u)
            }
        };
        let mean_cos = |u: f64, v: f64| {
            if (v - u).abs() < 1e-5 {
                ((u + v) * 0.5).cos()
            } else {
                (v.sin() - u.sin()) / (v - u)
            }
        };
        let cost = squared.sqrt()
            * uncertainty
            * (0.65
                + 0.35 * mean_sin(a.x * 0.31 + self.phase[0], b.x * 0.31 + self.phase[0])
                + 0.3 * mean_cos(a.y * 0.27 + self.phase[1], b.y * 0.27 + self.phase[1]));
        // Forecasts are short lived; bound per-query memoization independently
        // of graph size while sharing immutable occluders with the belief map.
        if self.costs.borrow().len() < 2048 {
            self.costs.borrow_mut().insert(key, cost);
        }
        cost
    }
}

/// Select a tentative viewing position. Only observed wall fragments and
/// hypothetical nearby floor supply candidates; window coordinates never do.
pub(super) fn search_route(
    scenario: &BuildingScenario,
    agent: &Agent,
    geometry: &Geometry<'_>,
    navigation: &Navigation,
    visited: &[Point],
    architecture: &super::architecture::Architecture,
) -> Option<Route> {
    if scenario.awareness.visibility_range() <= 0.0 {
        return None;
    }
    let distance = 5.0;
    let clearance = scenario.agent_radius + 0.15;
    let mut targets = Vec::new();
    for (a, b, thickness) in geometry.wall_fragments() {
        let length = math::distance_to_point(a, b);
        if length <= math::EPSILON {
            continue;
        }
        let normal = Point {
            x: -(b.y - a.y) / length,
            y: (b.x - a.x) / length,
        };
        for p in [a, math::interpolate(a, b, 0.5), b] {
            for side in [-1.0, 1.0] {
                targets.push(Point {
                    x: p.x + side * (clearance + thickness) * normal.x,
                    y: p.y + side * (clearance + thickness) * normal.y,
                });
            }
        }
    }
    let phase = sample(scenario.seed, agent.id, 3) * std::f64::consts::TAU;
    for i in 0..8 {
        let angle = phase + i as f64 * std::f64::consts::TAU / 8.0;
        targets.push(Point {
            x: agent.position.x + distance * angle.cos(),
            y: agent.position.y + distance * angle.sin(),
        });
    }
    let forecast = CrowdForecast::for_geometry(geometry).with_discovery(scenario, agent, geometry);
    let mut best: Option<(f64, Route)> = None;
    targets.retain(|&target| {
        math::distance_to_point(agent.position, target) >= distance * 0.4
            && math::distance_to_point(agent.position, target) <= 2.0 * distance
            && !visited
                .iter()
                .any(|&p| math::distance_to_point(p, target) < distance * 0.65)
            && geometry.can_stand_at(target)
            && !geometry.has_line_of_sight(agent.position, target)
            && (!architecture.contains(agent.position) || architecture.contains(target))
    });
    targets.sort_by(|&a, &b| {
        math::distance_to_point(agent.position, a)
            .total_cmp(&math::distance_to_point(agent.position, b))
    });
    // Bound work independently of the number of remembered wall fragments.
    for target in targets.into_iter().take(12) {
        let Some(route) = navigation
            .with_point_target("window-search".into(), target)
            .find_safe_route_with_forecast(
                agent.position,
                geometry,
                &forecast,
                scenario.agent_radius,
            )
        else {
            continue;
        };
        if !architecture.allows_exploration(agent.position, &route.waypoints) {
            continue;
        }
        let cost = navigation::route_cost(
            agent.position,
            &route.waypoints,
            &forecast,
            scenario.agent_radius,
        );
        // Prefer nearby new views. The bounded search will return to the exit
        // plan if it finds no usable window; these are not evacuation targets.
        if best.as_ref().is_none_or(|(current, _)| cost < *current) {
            best = Some((cost, route));
        }
    }
    best.map(|(_, route)| route)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fully_visible_room_does_not_investigate_blank_exterior_walls() {
        let b: BuildingScenario=serde_json::from_value(serde_json::json!({
            "width":20,"height":20,"agent_radius":0.2,"time_step_seconds":0.1,"max_steps":100,"seed":42,
            "walls":[
                {"id":"north","start":{"x":2,"y":2},"end":{"x":18,"y":2},"thickness":0.2},
                {"id":"east","start":{"x":18,"y":2},"end":{"x":18,"y":18},"thickness":0.2},
                {"id":"south","start":{"x":18,"y":18},"end":{"x":2,"y":18},"thickness":0.2},
                {"id":"west","start":{"x":2,"y":18},"end":{"x":2,"y":2},"thickness":0.2}],
            "doors":[],"exits":[{"id":"out","wall_id":"north","offset":7,"width":2}],
            "spawn_zones":[],"blocked_exit_ids":[],"obstructions":[]
        })).unwrap();
        let architecture = super::super::architecture::Architecture::new(&b);
        let geometry = Geometry::new(&b);
        let navigation = Navigation::new(&b, &geometry);
        for point in [
            Point { x: 10.0, y: 10.0 },
            Point { x: 3.0, y: 3.0 },
            Point { x: 17.0, y: 16.0 },
        ] {
            let person = Agent::new(0, point);
            assert!(
                search_route(&b, &person, &geometry, &navigation, &[], &architecture).is_none()
            );
        }
    }

    #[test]
    fn unseen_travel_has_repeatable_personal_detour_costs() {
        let mut b: BuildingScenario = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../shared/examples/building.json"
        )))
        .unwrap();
        b.walls.clear();
        b.doors.clear();
        b.exits.clear();
        b.obstructions.clear();
        b.obstructions.push(crate::models::Obstruction {
            id: "screen".into(),
            name: None,
            x: 10.0,
            y: 0.0,
            width: 1.0,
            height: 20.0,
        });
        let person = Agent::new(0, Point { x: 5.0, y: 5.0 });
        let geometry = Geometry::new(&b);
        let outlook = Outlook::new(&b, &person, &geometry);
        assert_eq!(
            outlook.cost(person.position, Point { x: 5.0, y: 100.0 }),
            0.0,
            "distance alone must never make a visible path uncertain"
        );
        let start = Point { x: 15.0, y: 5.0 };
        let end = Point { x: 25.0, y: 5.0 };
        let cost = outlook.cost(start, end);
        assert!(
            cost > 1.0,
            "travel in an occluded area still carries detour uncertainty"
        );
        let middle = math::interpolate(start, end, 0.37);
        assert!((cost - outlook.cost(start, middle) - outlook.cost(middle, end)).abs() < 1e-8);
        assert_eq!(cost, Outlook::new(&b, &person, &geometry).cost(start, end));
        assert_ne!(
            cost,
            Outlook::new(&b, &Agent::new(1, person.position), &geometry).cost(start, end)
        );
        let mut other = b.clone();
        other.seed += 1;
        assert_ne!(
            cost,
            Outlook::new(&other, &person, &geometry).cost(start, end)
        );
    }
}
