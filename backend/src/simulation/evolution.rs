//! Seeded footprint evolution. No randomness is shared with occupant spawning.
use super::{geometry::Geometry, math};
use crate::models::{BuildingScenario, Disaster, DisasterKind, DisasterState, HazardArea, Point};

pub(super) struct HazardEvolution {
    pub state: DisasterState,
    config: Disaster,
    random: u64,
    last_step: u32,
    next_spread: f64,
    next_turn: f64,
    heading: f64,
    target_heading: f64,
    speed: f64,
}

impl HazardEvolution {
    pub fn new(config: Disaster, seed: u64) -> Self {
        let mut result = Self {
            state: DisasterState::initial(config),
            config,
            random: seed ^ 0xd1b54a32d192ed03,
            last_step: 0,
            next_spread: config
                .dynamics
                .map_or(f64::INFINITY, |d| d.spread_interval_seconds),
            next_turn: 0.0,
            heading: 0.0,
            target_heading: 0.0,
            speed: 0.0,
        };
        result.heading = result.sample() * std::f64::consts::TAU;
        result.target_heading = result.heading;
        result
    }

    fn sample(&mut self) -> f64 {
        self.random = self.random.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.random;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        ((z ^ (z >> 31)) >> 11) as f64 / ((1_u64 << 53) as f64)
    }

    pub fn is_changing(&self) -> bool {
        self.config.dynamics.filter(|d| d.enabled).is_some_and(|d| {
            if self.config.kind == DisasterKind::Tornado {
                d.speed > 0.0
            } else {
                (self.config.kind == DisasterKind::Fire
                    && self.state.areas.len() < d.max_patches as usize)
                    || (d.growth_rate > 0.0
                        && self
                            .state
                            .areas
                            .iter()
                            .any(|area| area.radius < d.max_radius))
            }
        })
    }

    /// Advancing to the same tick is idempotent, including RNG state.
    pub fn advance(&mut self, step: u32, scenario: &BuildingScenario) -> bool {
        if step <= self.last_step {
            return false;
        }
        let Some(dynamics) = self.config.dynamics.filter(|d| d.enabled) else {
            self.last_step = step;
            return false;
        };
        let mut changed = false;
        for tick in self.last_step + 1..=step {
            let dt = scenario.time_step_seconds;
            let now = f64::from(tick) * dt;
            if self.config.kind == DisasterKind::Tornado {
                if dynamics.speed > 0.0 {
                    let before = self.state.areas[0].center;
                    let substeps = (dt / 0.025).ceil().max(1.0) as u32;
                    for sub in 0..substeps {
                        let time = now - dt + f64::from(sub + 1) * dt / f64::from(substeps);
                        self.move_tornado(dt / f64::from(substeps), time, scenario);
                    }
                    let after = self.state.areas[0].center;
                    if math::distance_to_point(before, after) > 0.0 {
                        self.state.areas[0].revision = tick;
                        changed = true;
                    }
                }
            } else {
                for area in &mut self.state.areas {
                    // Persistent per-patch variation produces uneven growth.
                    let variation = if self.config.kind == DisasterKind::GasLeak {
                        1.0
                    } else {
                        0.7 + f64::from((area.id.wrapping_mul(37) + 19) % 61) / 100.0
                    };
                    let radius = (area.radius + dt * dynamics.growth_rate * variation)
                        .min(dynamics.max_radius);
                    if radius > area.radius {
                        area.radius = radius;
                        area.revision = tick;
                        changed = true;
                    }
                }
                while self.config.kind == DisasterKind::Fire
                    && now + 1e-9 >= self.next_spread
                    && self.state.areas.len() < dynamics.max_patches as usize
                {
                    self.next_spread += dynamics.spread_interval_seconds;
                    changed |= self.ignite_frontier(tick, scenario);
                }
            }
        }
        self.last_step = step;
        changed
    }

    /// Score the whole reached frontier, rather than repeatedly extending its
    /// newest tip. Nearby wall surfaces guide most ignitions; regular floor
    /// ignitions fill behind that front. This is an illustrative propagation
    /// rule, not a fuel, airflow, or material-combustion model.
    fn ignite_frontier(&mut self, tick: u32, scenario: &BuildingScenario) -> bool {
        let radius = (self.config.radius * 0.55)
            .max(0.01)
            .min(self.config.dynamics.unwrap().max_radius);
        // Reuse the simulation's wall/opening decomposition. Furniture does not
        // divide a room for this model, but intact walls block ignition paths.
        let geometry = Geometry::with_blocked_openings(
            scenario,
            &[],
            scenario.blocked_exit_ids.iter().cloned().collect(),
        );
        let walls: Vec<_> = geometry.wall_fragments().collect();
        let floor_ignition = self.state.areas.len().is_multiple_of(4);
        let mut best: Option<(f64, Point)> = None;
        for index in 0..self.state.areas.len() {
            let parent = self.state.areas[index];
            let phase = self.sample() * std::f64::consts::TAU;
            let mut angles: Vec<_> = (0..16)
                .map(|direction| phase + f64::from(direction) * std::f64::consts::TAU / 16.0)
                .collect();
            // Exact tangents keep a front following even thin angled walls,
            // without relying on a sampled direction happening to align.
            for &(start, end, half_thickness) in &walls {
                if math::distance_to_segment(parent.center, start, end) - half_thickness
                    <= parent.radius + radius
                {
                    let tangent = (end.y - start.y).atan2(end.x - start.x);
                    angles.extend([tangent, tangent + std::f64::consts::PI]);
                }
            }
            for angle in angles {
                let distance = parent.radius + radius * 0.5;
                let center = Point {
                    x: parent.center.x + angle.cos() * distance,
                    y: parent.center.y + angle.sin() * distance,
                };
                if center.x < 0.0
                    || center.x > scenario.width
                    || center.y < 0.0
                    || center.y > scenario.height
                    || self.state.areas.iter().any(|area| {
                        math::distance_to_point(center, area.center) <= area.radius + radius * 0.1
                    })
                    || walls.iter().any(|&(start, end, half_thickness)| {
                        math::distance_to_segment(center, start, end)
                            <= half_thickness + radius * 0.1
                            || (math::distance_to_segment(parent.center, start, end)
                                > half_thickness + math::EPSILON
                                && math::distance_between_segments(
                                    parent.center,
                                    center,
                                    start,
                                    end,
                                ) <= half_thickness)
                    })
                {
                    continue;
                }
                let wall_gap = walls
                    .iter()
                    .map(|&(start, end, half_thickness)| {
                        math::distance_to_segment(center, start, end) - half_thickness
                    })
                    .fold(f64::INFINITY, f64::min);
                let wall_priority = if floor_ignition {
                    0.0
                } else {
                    3.0 / (1.0 + wall_gap / radius)
                };
                // Prefer fresh area and less advanced sides of the fire, so a
                // single lucky branch cannot consume the entire patch budget.
                let fresh = (0..8)
                    .filter(|sample| {
                        let a = f64::from(*sample) * std::f64::consts::TAU / 8.0;
                        let edge = Point {
                            x: center.x + a.cos() * radius,
                            y: center.y + a.sin() * radius,
                        };
                        self.state
                            .areas
                            .iter()
                            .all(|area| math::distance_to_point(edge, area.center) > area.radius)
                    })
                    .count() as f64
                    / 8.0;
                let score = wall_priority + fresh
                    - 0.035 * math::distance_to_point(center, self.config.center) / radius
                    + self.sample() * 0.05;
                if best.is_none_or(|(old_score, _)| score > old_score) {
                    best = Some((score, center));
                }
            }
        }
        if let Some((_, center)) = best {
            self.state.areas.push(HazardArea {
                id: self.state.areas.len() as u32,
                revision: tick,
                center,
                radius,
            });
            return true;
        }
        false
    }

    fn move_tornado(&mut self, dt: f64, now: f64, scenario: &BuildingScenario) {
        let d = self.config.dynamics.unwrap();
        if now >= self.next_turn {
            self.target_heading = self.sample() * std::f64::consts::TAU;
            self.next_turn = now + d.wander_interval_seconds;
        }
        let from = self.state.areas[0].center;
        let clearance = self.config.exposure_radius() + scenario.agent_radius + d.shelter_clearance;
        let lookahead = (d.speed * 2.0).max(1.0);
        let mut desired = Point {
            x: self.target_heading.cos(),
            y: self.target_heading.sin(),
        };
        let mut gap = from
            .x
            .min(scenario.width - from.x)
            .min(from.y)
            .min(scenario.height - from.y);
        for (distance, normal) in [
            (from.x, Point { x: 1.0, y: 0.0 }),
            (scenario.width - from.x, Point { x: -1.0, y: 0.0 }),
            (from.y, Point { x: 0.0, y: 1.0 }),
            (scenario.height - from.y, Point { x: 0.0, y: -1.0 }),
        ] {
            let weight = ((lookahead - distance) / lookahead).max(0.0) * 4.0;
            desired.x += weight * normal.x;
            desired.y += weight * normal.y;
        }
        for zone in &scenario.tornado_zones {
            let closest = Point {
                x: from.x.clamp(zone.x, zone.x + zone.width),
                y: from.y.clamp(zone.y, zone.y + zone.height),
            };
            let distance = math::distance_to_point(from, closest).max(1e-9);
            let separation = distance - clearance;
            gap = gap.min(separation);
            let weight = ((lookahead - separation) / lookahead).clamp(0.0, 2.0) * 6.0;
            desired.x += weight * (from.x - closest.x) / distance;
            desired.y += weight * (from.y - closest.y) / distance;
        }
        let desired_heading = desired.y.atan2(desired.x);
        let delta = (desired_heading - self.heading + std::f64::consts::PI)
            .rem_euclid(std::f64::consts::TAU)
            - std::f64::consts::PI;
        self.heading += delta.clamp(
            -d.turn_rate_degrees.to_radians() * dt,
            d.turn_rate_degrees.to_radians() * dt,
        );
        let forward = Point {
            x: self.heading.cos(),
            y: self.heading.sin(),
        };
        let alignment =
            (forward.x * desired.x + forward.y * desired.y) / desired.x.hypot(desired.y).max(1e-9);
        let target_speed = d.speed.min((4.0 * gap.max(0.0)).sqrt()) * alignment.max(0.0);
        self.speed += (target_speed - self.speed).clamp(-2.0 * dt, 2.0 * dt);
        let wanted = Point {
            x: from.x + forward.x * self.speed * dt,
            y: from.y + forward.y * self.speed * dt,
        };
        let safe = |to: Point| {
            to.x >= 0.0
                && to.x <= scenario.width
                && to.y >= 0.0
                && to.y <= scenario.height
                && scenario.tornado_zones.iter().all(|zone| {
                    math::distance_segment_to_rectangle(
                        from,
                        to,
                        zone.x,
                        zone.y,
                        zone.width,
                        zone.height,
                    ) > clearance
                })
        };
        let mut fraction = 1.0;
        if !safe(wanted) {
            let (mut left, mut right) = (0.0, 1.0);
            for _ in 0..16 {
                let middle = (left + right) / 2.0;
                if safe(math::interpolate(from, wanted, middle)) {
                    left = middle;
                } else {
                    right = middle;
                }
            }
            fraction = left;
            self.speed *= fraction;
        }
        let accepted = math::interpolate(from, wanted, fraction);
        debug_assert!(
            safe(accepted),
            "tornado movement crossed a protected shelter or workspace boundary"
        );
        self.state.areas[0].center = accepted;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DisasterDynamics, Obstruction, Wall};

    fn scenario(kind: DisasterKind) -> BuildingScenario {
        let mut scenario: BuildingScenario =
            serde_json::from_str(include_str!("../../../shared/examples/building.json")).unwrap();
        scenario.disaster = Some(Disaster {
            kind,
            center: Point { x: 5.0, y: 5.0 },
            radius: 0.7,
            dynamics: Some(DisasterDynamics {
                spread_interval_seconds: 0.5,
                max_patches: 8,
                max_radius: 2.0,
                ..Default::default()
            }),
        });
        scenario
    }

    #[test]
    fn fire_branches_repeatably_along_existing_burning_edges_with_bounded_growth() {
        let scenario = scenario(DisasterKind::Fire);
        let mut a = HazardEvolution::new(scenario.disaster.unwrap(), 42);
        let mut b = HazardEvolution::new(scenario.disaster.unwrap(), 42);
        let mut different = HazardEvolution::new(scenario.disaster.unwrap(), 43);
        for tick in 1..=100 {
            a.advance(tick, &scenario);
        }
        b.advance(100, &scenario);
        b.advance(100, &scenario);
        different.advance(100, &scenario);
        let json = |value: &HazardEvolution| serde_json::to_value(&value.state).unwrap();
        assert_eq!(
            json(&a),
            json(&b),
            "sampling or repeated calls must not change RNG progression"
        );
        assert_ne!(json(&a), json(&different));
        assert_eq!(a.state.areas.len(), 8);
        assert!(a.state.areas.iter().all(|area| area.radius <= 2.0
            && area.radius > 0.0
            && area.center.x >= 0.0
            && area.center.x <= scenario.width
            && area.center.y >= 0.0
            && area.center.y <= scenario.height));
        assert!(a.state.areas[0].radius > scenario.disaster.unwrap().radius);
        assert!(
            a.state
                .areas
                .iter()
                .any(|area| (area.center.x - 5.0).abs() > 0.1 && (area.center.y - 5.0).abs() > 0.1)
        );
    }

    #[test]
    fn new_fire_ignites_fresh_ground_touching_the_existing_frontier() {
        let mut scenario = scenario(DisasterKind::Fire);
        let dynamics = scenario
            .disaster
            .as_mut()
            .unwrap()
            .dynamics
            .as_mut()
            .unwrap();
        dynamics.growth_rate = 0.0;
        dynamics.max_patches = 32;
        let mut fire = HazardEvolution::new(scenario.disaster.unwrap(), 42);
        for tick in 1..=200 {
            let old_count = fire.state.areas.len();
            fire.advance(tick, &scenario);
            for new in &fire.state.areas[old_count..] {
                let existing = &fire.state.areas[..new.id as usize];
                assert!(
                    existing
                        .iter()
                        .any(|old| math::distance_to_point(old.center, new.center)
                            < old.radius + new.radius),
                    "new fire must touch an already burning area"
                );
                assert!(
                    existing
                        .iter()
                        .all(|old| math::distance_to_point(old.center, new.center) > old.radius),
                    "a new ignition must not be buried inside existing fire"
                );
            }
        }
        assert_eq!(fire.state.areas.len(), 32);
        let origin = scenario.disaster.unwrap();
        assert!(
            fire.state
                .areas
                .iter()
                .any(|area| math::distance_to_point(area.center, origin.center)
                    > origin.radius + 2.0 * area.radius),
            "spread must propagate beyond the initial source, even without radius growth"
        );
    }

    #[test]
    fn open_floor_fire_spreads_in_every_direction_instead_of_following_one_tip() {
        for seed in [1, 42, 43, 110] {
            let mut scenario = scenario(DisasterKind::Fire);
            scenario.walls.clear();
            scenario.doors.clear();
            scenario.exits.clear();
            scenario.width = 40.0;
            scenario.height = 40.0;
            let config = scenario.disaster.as_mut().unwrap();
            config.center = Point { x: 20.0, y: 20.0 };
            let dynamics = config.dynamics.as_mut().unwrap();
            dynamics.growth_rate = 0.0;
            dynamics.max_patches = 32;
            let mut fire = HazardEvolution::new(*config, seed);
            fire.advance(200, &scenario);
            for (x, y) in [(-1.0, -1.0), (-1.0, 1.0), (1.0, -1.0), (1.0, 1.0)] {
                assert!(
                    fire.state.areas.iter().any(|area| {
                        (area.center.x - 20.0) * x > 0.5 && (area.center.y - 20.0) * y > 0.5
                    }),
                    "seed {seed} must reach all four sides of its initial fire"
                );
            }
        }
    }

    #[test]
    fn fire_reaches_wall_then_follows_both_directions_and_branches_onto_floor() {
        let mut scenario = scenario(DisasterKind::Fire);
        scenario.width = 30.0;
        scenario.height = 30.0;
        scenario.walls = vec![Wall {
            id: "divider".into(),
            name: None,
            start: Point { x: 6.0, y: 0.0 },
            end: Point { x: 6.0, y: 30.0 },
            thickness: 0.2,
        }];
        scenario.doors.clear();
        scenario.exits.clear();
        let config = scenario.disaster.as_mut().unwrap();
        config.center = Point { x: 5.0, y: 15.0 };
        let dynamics = config.dynamics.as_mut().unwrap();
        dynamics.growth_rate = 0.0;
        dynamics.max_patches = 64;
        let mut fire = HazardEvolution::new(*config, 42);
        fire.advance(10, &scenario);
        assert!(
            fire.state.areas[1..].iter().all(|area| area.center.x > 5.5),
            "the earliest ignitions should seek the nearby wall surface"
        );
        fire.advance(400, &scenario);
        assert_eq!(fire.state.areas.len(), 64);
        assert!(fire.state.areas.iter().all(|area| area.center.x < 5.9));
        for direction in [-1.0, 1.0] {
            assert!(
                fire.state.areas.iter().any(|area| {
                    area.center.x > 5.5 && (area.center.y - 15.0) * direction > 3.0
                })
            );
        }
        assert!(
            fire.state.areas.iter().any(|area| area.center.x < 4.0),
            "floor ignitions must continue while the wall front advances"
        );
    }

    #[test]
    fn gas_stays_one_cloud_growing_at_the_configured_rate_even_with_legacy_branching_settings() {
        let scenario = scenario(DisasterKind::GasLeak);
        let config = scenario.disaster.unwrap();
        let mut gas = HazardEvolution::new(config, 42);
        let mut other_seed = HazardEvolution::new(config, 99);
        for tick in 1..=100 {
            gas.advance(tick, &scenario);
            assert_eq!(gas.state.areas.len(), 1);
            assert_eq!(gas.state.areas[0].center.x, config.center.x);
            assert_eq!(gas.state.areas[0].center.y, config.center.y);
            let expected = config.radius
                + f64::from(tick)
                    * scenario.time_step_seconds
                    * config.dynamics.unwrap().growth_rate;
            assert!((gas.state.areas[0].radius - expected).abs() < 1e-9);
        }
        other_seed.advance(100, &scenario);
        assert_eq!(
            serde_json::to_value(&gas.state).unwrap(),
            serde_json::to_value(&other_seed.state).unwrap()
        );
        gas.advance(1000, &scenario);
        assert_eq!(
            gas.state.areas[0].radius,
            config.dynamics.unwrap().max_radius
        );
        assert!(
            !gas.is_changing(),
            "unused patch capacity must not keep a capped cloud active"
        );
        assert!(!gas.advance(1001, &scenario));
    }

    #[test]
    fn disabled_dynamics_and_user_growth_limits_are_respected() {
        let mut scenario = scenario(DisasterKind::Fire);
        let mut config = scenario.disaster.unwrap();
        config.dynamics.as_mut().unwrap().enabled = false;
        let mut disabled = HazardEvolution::new(config, 42);
        let initial = serde_json::to_value(&disabled.state).unwrap();
        assert!(!disabled.advance(1000, &scenario));
        assert_eq!(initial, serde_json::to_value(&disabled.state).unwrap());
        config.dynamics = Some(DisasterDynamics {
            growth_rate: 2.0,
            spread_interval_seconds: 0.25,
            max_patches: 3,
            max_radius: 0.8,
            ..Default::default()
        });
        scenario.disaster = Some(config);
        let mut bounded = HazardEvolution::new(config, 42);
        bounded.advance(1000, &scenario);
        assert_eq!(bounded.state.areas.len(), 3);
        assert!(
            bounded
                .state
                .areas
                .iter()
                .all(|area| (area.radius - 0.8).abs() < 1e-9)
        );
        assert!(!bounded.is_changing());
        config.radius = 0.005;
        config.dynamics.as_mut().unwrap().max_radius = 0.01;
        let mut tiny = HazardEvolution::new(config, 42);
        tiny.advance(10, &scenario);
        assert!(tiny.state.areas.iter().all(|area| area.radius <= 0.01));
    }

    #[test]
    fn tornado_wanders_smoothly_without_entering_any_shelter_or_leaving_the_workspace() {
        for seed in [1, 42, 110] {
            let mut scenario = scenario(DisasterKind::Tornado);
            scenario.tornado_zones = vec![
                Obstruction {
                    id: "safe".into(),
                    name: None,
                    x: 12.0,
                    y: 7.0,
                    width: 5.0,
                    height: 5.0,
                },
                Obstruction {
                    id: "safe2".into(),
                    name: None,
                    x: 22.0,
                    y: 2.0,
                    width: 2.0,
                    height: 3.0,
                },
            ];
            let mut tornado = HazardEvolution::new(scenario.disaster.unwrap(), seed);
            let dynamics = scenario.disaster.unwrap().dynamics.unwrap();
            let clearance = scenario.disaster.unwrap().exposure_radius()
                + scenario.agent_radius
                + dynamics.shelter_clearance;
            let mut farthest = 0.0_f64;
            for tick in 1..=2000 {
                let before = tornado.state.areas[0].center;
                let heading = tornado.heading;
                tornado.advance(tick, &scenario);
                let after = tornado.state.areas[0].center;
                assert!(
                    math::distance_to_point(before, after)
                        <= dynamics.speed * scenario.time_step_seconds + 1e-8
                );
                assert!(
                    (tornado.heading - heading).abs()
                        <= dynamics.turn_rate_degrees.to_radians() * scenario.time_step_seconds
                            + 1e-8
                );
                assert!(
                    after.x >= 0.0
                        && after.x <= scenario.width
                        && after.y >= 0.0
                        && after.y <= scenario.height
                );
                for zone in &scenario.tornado_zones {
                    assert!(
                        math::distance_to_rectangle(after, zone.x, zone.y, zone.width, zone.height)
                            > clearance
                    );
                }
                farthest = farthest.max(math::distance_to_point(after, Point { x: 5.0, y: 5.0 }));
            }
            assert!(
                farthest > 3.0,
                "the tornado should roam instead of vibrating at its origin"
            );
        }
    }
}
