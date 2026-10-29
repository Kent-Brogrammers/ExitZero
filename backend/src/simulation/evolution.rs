//! Seeded footprint evolution. No randomness is shared with occupant spawning.
use super::math;
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
                        && self.state.areas.iter().enumerate().any(|(i, area)| {
                            area.radius + 1e-12
                                < if self.config.kind == DisasterKind::Fire {
                                    self.fire_radius_limit(i, d.max_radius)
                                } else {
                                    d.max_radius
                                }
                        }))
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
                if self.config.kind == DisasterKind::Fire {
                    changed |= self.grow_fire(tick, dt);
                }
                for area in self
                    .state
                    .areas
                    .iter_mut()
                    .filter(|_| self.config.kind == DisasterKind::GasLeak)
                {
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

    /// Cap every fire pod independently and stop neighboring cores from swallowing one another.
    fn fire_radius_limit(&self, index: usize, maximum: f64) -> f64 {
        let area = self.state.areas[index];
        self.state
            .areas
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != index)
            .fold(maximum, |limit, (_, other)| {
                limit.min(math::distance_to_point(area.center, other.center) / 0.88 - other.radius)
            })
    }
    fn grow_fire(&mut self, tick: u32, dt: f64) -> bool {
        let d = self.config.dynamics.unwrap();
        let mut changed = false;
        for i in 0..self.state.areas.len() {
            let old = self.state.areas[i];
            let limit = self.fire_radius_limit(i, d.max_radius);
            let radius = (old.radius + dt * d.growth_rate).min(limit).max(old.radius);
            if radius > old.radius {
                self.state.areas[i].radius = radius;
                self.state.areas[i].revision = tick;
                changed = true;
            }
        }
        changed
    }

    /// Compare all flame frontiers in every direction. Favor wall-side propagation,
    /// periodically filling inward, with only a small connecting overlap between cores.
    fn ignite_frontier(&mut self, tick: u32, scenario: &BuildingScenario) -> bool {
        let radius = (self.config.radius * 0.65)
            .max(0.01)
            .min(self.config.dynamics.unwrap().max_radius);
        let rotation = self.sample() * std::f64::consts::TAU;
        let inward = self.state.areas.len().is_multiple_of(5);
        let parents = self.state.areas.clone();
        let openings = fire_opening_targets(tick, scenario);
        let mut best: Option<(f64, Point)> = None;
        for parent in &parents {
            let distance = parent.radius + radius * 0.85;
            let sampled = (0..32).map(|direction| {
                let angle = rotation + f64::from(direction) * std::f64::consts::TAU / 32.0;
                (
                    Point {
                        x: angle.cos(),
                        y: angle.sin(),
                    },
                    false,
                )
            });
            // Aim through reachable apertures explicitly: a narrow opening can
            // fall between every sampled angle. Keep the ordinary frontier
            // distance so openings cannot make fire jump across a room.
            let directed = openings.iter().filter_map(|&target| {
                let gap = math::distance_to_point(parent.center, target);
                (gap > 1e-10 && gap < distance).then(|| {
                    (
                        Point {
                            x: (target.x - parent.center.x) / gap,
                            y: (target.y - parent.center.y) / gap,
                        },
                        true,
                    )
                })
            });
            for (direction, through_opening) in sampled.chain(directed) {
                let center = Point {
                    x: parent.center.x + direction.x * distance,
                    y: parent.center.y + direction.y * distance,
                };
                if center.x < 0.0
                    || center.x > scenario.width
                    || center.y < 0.0
                    || center.y > scenario.height
                    || parents.iter().any(|a| {
                        math::distance_to_point(center, a.center) < (a.radius + radius) * 0.88
                    })
                    || !fire_path_clear(parent.center, center, tick, scenario)
                {
                    continue;
                }
                let wall_distance = scenario
                    .walls
                    .iter()
                    .map(|w| math::distance_to_segment(center, w.start, w.end) - w.thickness / 2.0)
                    .fold(f64::INFINITY, f64::min)
                    .max(0.0);
                let wall_bonus = if inward {
                    0.0
                } else {
                    2.5 / (1.0 + (wall_distance - radius * 0.65).abs() / radius)
                };
                let fresh = (0..16)
                    .filter(|&i| {
                        let a = f64::from(i) * std::f64::consts::TAU / 16.0;
                        let p = Point {
                            x: center.x + radius * 0.8 * a.cos(),
                            y: center.y + radius * 0.8 * a.sin(),
                        };
                        parents
                            .iter()
                            .all(|old| math::distance_to_point(p, old.center) > old.radius)
                    })
                    .count() as f64
                    / 16.0;
                let opening_bonus = if through_opening { 2.5 } else { 0.0 };
                let score = 2.0 * fresh + wall_bonus + opening_bonus
                    - self.sample() * 0.15
                    - math::distance_to_point(center, self.config.center) * 0.01;
                if best.is_none_or(|(old, _)| score > old) {
                    best = Some((score, center));
                }
            }
        }
        let Some((_, center)) = best else {
            return false;
        };
        self.state.areas.push(HazardArea {
            id: self.state.areas.len() as u32,
            revision: tick,
            center,
            radius,
        });
        true
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

fn opening_blocked(id: &str, tick: u32, scenario: &BuildingScenario) -> bool {
    scenario
        .opening_events
        .iter()
        .rev()
        .find(|event| event.opening_id == id && event.step <= tick)
        .map_or_else(
            || {
                scenario
                    .blocked_exit_ids
                    .iter()
                    .any(|blocked| blocked == id)
            },
            |event| event.blocked,
        )
}

/// Fire apertures are separate from occupant traversal and window preparation.
fn fire_opening_targets(tick: u32, scenario: &BuildingScenario) -> Vec<Point> {
    scenario
        .doors
        .iter()
        .chain(&scenario.exits)
        .filter(|opening| !opening_blocked(&opening.id, tick, scenario))
        .map(|opening| (opening.wall_id.as_str(), opening.offset, opening.width))
        .chain(
            scenario
                .windows
                .iter()
                .map(|window| (window.wall_id.as_str(), window.offset, window.width)),
        )
        .filter_map(|(wall_id, offset, width)| {
            scenario
                .walls
                .iter()
                .find(|wall| wall.id == wall_id)
                .map(|wall| {
                    math::interpolate(wall.start, wall.end, (offset + width / 2.0) / wall.length())
                })
        })
        .collect()
}

/// Fire can pass through available doors and window apertures, never solid wall.
fn fire_path_clear(from: Point, to: Point, tick: u32, scenario: &BuildingScenario) -> bool {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    scenario.walls.iter().all(|wall| {
        let wx = wall.end.x - wall.start.x;
        let wy = wall.end.y - wall.start.y;
        let den = dx * wy - dy * wx;
        if den.abs() < 1e-10 {
            return true;
        }
        let ax = wall.start.x - from.x;
        let ay = wall.start.y - from.y;
        let t = (ax * wy - ay * wx) / den;
        let u = (ax * dy - ay * dx) / den;
        if !(1e-8..1.0 - 1e-8).contains(&t) || !(0.0..=1.0).contains(&u) {
            return true;
        }
        let offset = u * wall.length();
        scenario.doors.iter().chain(&scenario.exits).any(|o| {
            o.wall_id == wall.id
                && !opening_blocked(&o.id, tick, scenario)
                && offset > o.offset
                && offset < o.offset + o.width
        }) || scenario.windows.iter().any(|window| {
            window.wall_id == wall.id
                && offset > window.offset
                && offset < window.offset + window.width
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DisasterDynamics, TornadoZone};

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
                .all(|area| area.radius <= 0.8 && area.radius > 0.0)
        );
        assert!(!bounded.is_changing());
        config.radius = 0.005;
        config.dynamics.as_mut().unwrap().max_radius = 0.01;
        let mut tiny = HazardEvolution::new(config, 42);
        tiny.advance(10, &scenario);
        assert!(tiny.state.areas.iter().all(|area| area.radius <= 0.01));
    }

    #[test]
    fn fire_fronts_spread_in_all_directions_without_core_pileups() {
        let mut scenario = scenario(DisasterKind::Fire);
        scenario.walls.clear();
        let config = scenario.disaster.as_mut().unwrap();
        config.center = Point { x: 15.0, y: 10.0 };
        let d = config.dynamics.as_mut().unwrap();
        d.max_patches = 32;
        d.max_radius = 0.8;
        d.spread_interval_seconds = 0.25;
        let mut fire = HazardEvolution::new(*config, 42);
        fire.advance(200, &scenario);
        assert_eq!(fire.state.areas.len(), 32);
        for area in &fire.state.areas {
            assert!(area.radius <= 0.8);
        }
        for axis in [true, false] {
            let values: Vec<_> = fire
                .state
                .areas
                .iter()
                .map(|a| {
                    if axis {
                        a.center.x - 15.0
                    } else {
                        a.center.y - 10.0
                    }
                })
                .collect();
            assert!(
                values.iter().any(|&v| v > 0.8) && values.iter().any(|&v| v < -0.8),
                "fire must explore both directions of each axis"
            );
        }
        for (i, a) in fire.state.areas.iter().enumerate() {
            for b in &fire.state.areas[i + 1..] {
                assert!(
                    math::distance_to_point(a.center, b.center) + 1e-8
                        >= (a.radius + b.radius) * 0.88,
                    "neighboring pods must not grow over one another"
                );
            }
        }
    }

    #[test]
    fn fire_follows_both_wall_directions_then_fills_inward_without_crossing_solid_walls() {
        let mut scenario = scenario(DisasterKind::Fire);
        scenario.walls = vec![crate::models::Wall {
            id: "wall".into(),
            name: None,
            start: Point { x: 0.0, y: 5.0 },
            end: Point { x: 30.0, y: 5.0 },
            thickness: 0.2,
        }];
        scenario.doors.clear();
        scenario.exits.clear();
        let config = scenario.disaster.as_mut().unwrap();
        config.center = Point { x: 15.0, y: 5.6 };
        let d = config.dynamics.as_mut().unwrap();
        d.max_patches = 32;
        d.max_radius = 1.0;
        d.growth_rate = 0.0;
        d.spread_interval_seconds = 0.25;
        let mut fire = HazardEvolution::new(*config, 42);
        fire.advance(200, &scenario);
        assert_eq!(fire.state.areas.len(), 32);
        assert!(fire.state.areas[1..5].iter().all(|a| a.center.y < 6.2));
        assert!(fire.state.areas.iter().all(|a| a.center.y >= 5.0));
        assert!(fire.state.areas.iter().any(|a| a.center.x < 14.0));
        assert!(fire.state.areas.iter().any(|a| a.center.x > 16.0));
        assert!(fire.state.areas.iter().any(|a| a.center.y > 6.5));
        let from = Point { x: 15.0, y: 4.0 };
        let to = Point { x: 15.0, y: 6.0 };
        assert!(!fire_path_clear(from, to, 0, &scenario));
        scenario.doors.push(crate::models::Opening {
            id: "door".into(),
            name: None,
            wall_id: "wall".into(),
            offset: 14.0,
            width: 2.0,
        });
        assert!(fire_path_clear(from, to, 0, &scenario));
        scenario.opening_events = vec![crate::models::OpeningStateChange {
            step: 1,
            opening_id: "door".into(),
            blocked: true,
        }];
        assert!(!fire_path_clear(from, to, 1, &scenario));
    }

    #[test]
    fn fire_aims_through_narrow_doors_and_windows_on_horizontal_and_angled_walls() {
        for angled in [false, true] {
            for window in [false, true] {
                let mut scenario = scenario(DisasterKind::Fire);
                let tangent = if angled {
                    Point { x: 0.6, y: 0.8 }
                } else {
                    Point { x: 1.0, y: 0.0 }
                };
                let normal = Point {
                    x: -tangent.y,
                    y: tangent.x,
                };
                let opening = Point {
                    x: 5.0 + tangent.x * 5.0,
                    y: 5.0 + tangent.y * 5.0,
                };
                scenario.walls = vec![crate::models::Wall {
                    id: "wall".into(),
                    name: None,
                    start: Point { x: 5.0, y: 5.0 },
                    end: Point {
                        x: 5.0 + tangent.x * 10.0,
                        y: 5.0 + tangent.y * 10.0,
                    },
                    thickness: 0.2,
                }];
                scenario.doors.clear();
                scenario.exits.clear();
                scenario.windows.clear();
                scenario.opening_events.clear();
                scenario.blocked_exit_ids.clear();
                if window {
                    scenario.windows.push(crate::models::WindowOpening {
                        id: "window".into(),
                        name: None,
                        wall_id: "wall".into(),
                        offset: 4.999,
                        width: 0.002,
                        emergency_escape: None,
                    });
                } else {
                    scenario.doors.push(crate::models::Opening {
                        id: "door".into(),
                        name: None,
                        wall_id: "wall".into(),
                        offset: 4.999,
                        width: 0.002,
                    });
                }
                let config = scenario.disaster.as_mut().unwrap();
                config.center = Point {
                    x: opening.x + normal.x * 0.8 + tangent.x * 0.14,
                    y: opening.y + normal.y * 0.8 + tangent.y * 0.14,
                };
                config.dynamics.as_mut().unwrap().growth_rate = 0.0;
                config.dynamics.as_mut().unwrap().max_patches = 2;
                let source = config.center;
                let mut fire = HazardEvolution::new(*config, 42);
                let mut repeated = HazardEvolution::new(*config, 42);
                fire.advance(5, &scenario);
                repeated.advance(5, &scenario);
                assert_eq!(
                    serde_json::to_value(&fire.state).unwrap(),
                    serde_json::to_value(&repeated.state).unwrap()
                );
                assert_eq!(fire.state.areas.len(), 2);
                let reached = fire.state.areas[1];
                assert!(
                    (reached.center.x - opening.x) * normal.x
                        + (reached.center.y - opening.y) * normal.y
                        < 0.0,
                    "the first new patch should cross the reachable opening"
                );
                assert!(fire_path_clear(source, reached.center, 5, &scenario));
                assert!(
                    math::distance_to_point(source, reached.center)
                        < fire.state.areas[0].radius + reached.radius
                );
                let shifted = |point: Point| Point {
                    x: point.x + tangent.x * 0.1,
                    y: point.y + tangent.y * 0.1,
                };
                assert!(
                    !fire_path_clear(shifted(source), shifted(reached.center), 5, &scenario),
                    "adjacent solid wall must still stop fire"
                );
                if window {
                    assert!(
                        !super::super::geometry::Geometry::new(&scenario)
                            .can_move(source, reached.center),
                        "fire permeability must not let occupants walk through glazing"
                    );
                } else {
                    scenario.opening_events = vec![
                        crate::models::OpeningStateChange {
                            step: 1,
                            opening_id: "door".into(),
                            blocked: true,
                        },
                        crate::models::OpeningStateChange {
                            step: 2,
                            opening_id: "door".into(),
                            blocked: false,
                        },
                    ];
                    assert!(!fire_path_clear(source, reached.center, 1, &scenario));
                    assert!(fire_opening_targets(1, &scenario).is_empty());
                    assert!(fire_path_clear(source, reached.center, 2, &scenario));
                    assert_eq!(fire_opening_targets(2, &scenario).len(), 1);
                }
            }
        }
    }

    #[test]
    fn tornado_wanders_smoothly_without_entering_any_shelter_or_leaving_the_workspace() {
        for seed in [1, 42, 110] {
            let mut scenario = scenario(DisasterKind::Tornado);
            scenario.tornado_zones = vec![
                TornadoZone {
                    id: "safe".into(),
                    max_occupants: None,
                    name: None,
                    x: 12.0,
                    y: 7.0,
                    width: 5.0,
                    height: 5.0,
                },
                TornadoZone {
                    id: "safe2".into(),
                    max_occupants: None,
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
