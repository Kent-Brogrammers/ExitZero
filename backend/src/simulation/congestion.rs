//! Short-horizon traffic estimates from local sightings, used only for routing.
//! Forecasts never move agents or relax the real world's collision checks.
use std::collections::BTreeMap;

use super::{geometry::Geometry, math, motion::WALKING_SPEED, navigation};
use crate::models::Point;

const ZERO: Point = Point { x: 0.0, y: 0.0 };
const FLOW_SMOOTHING_SECONDS: f64 = 0.6;
const MOTION_CONFIRM_SECONDS: f64 = 1.0;
const ROUTE_CONFIRM_SECONDS: f64 = 1.0;
const ROUTE_COMMIT_SECONDS: f64 = 3.0;
const TURN_BACK_SECONDS: f64 = 1.75;
const FORECAST_TIMES: [f64; 3] = [1.0, 2.0, 3.0];
const FORECAST_WEIGHTS: [f64; 3] = [0.3, 0.3, 0.2];

struct Track {
    position: Point,
    velocity: Point,
    tick: u32,
    observed_seconds: f64,
}

#[derive(Default)]
pub(super) struct CrowdMemory {
    tracks: BTreeMap<usize, Track>,
}

struct Prediction {
    position: Point,
    velocity: Point,
    confidence: f64,
    future: [Option<Point>; 3],
}

#[derive(Default)]
pub(super) struct CrowdForecast {
    people: Vec<Prediction>,
}

impl CrowdMemory {
    /// Only consecutive sightings establish motion. Losing sight discards the
    /// track, so a new observer never inherits a hidden person's velocity.
    pub(super) fn observe(
        &mut self,
        visible: &[(usize, Point)],
        tick: u32,
        dt: f64,
        geometry: &Geometry<'_>,
    ) -> CrowdForecast {
        let mut people = Vec::with_capacity(visible.len());
        for &(id, position) in visible {
            let previous = self
                .tracks
                .get(&id)
                .filter(|track| track.tick.checked_add(1) == Some(tick));
            let (velocity, observed_seconds) = if let Some(track) = previous {
                let measured = Point {
                    x: (position.x - track.position.x) / dt,
                    y: (position.y - track.position.y) / dt,
                };
                let alpha = 1.0 - (-dt / FLOW_SMOOTHING_SECONDS).exp();
                let smooth = math::interpolate(track.velocity, measured, alpha);
                (
                    math::move_toward(ZERO, smooth, WALKING_SPEED),
                    track.observed_seconds + dt,
                )
            } else {
                (ZERO, 0.0)
            };
            let confidence = (observed_seconds / MOTION_CONFIRM_SECONDS).min(1.0);
            people.push(Prediction {
                position,
                velocity,
                confidence,
                future: if confidence == 0.0 || velocity.x.hypot(velocity.y) < 1e-6 {
                    [Some(position); 3]
                } else {
                    FORECAST_TIMES
                        .map(|seconds| geometry.predict_occupant(position, velocity, seconds))
                },
            });
            self.tracks.insert(
                id,
                Track {
                    position,
                    velocity,
                    tick,
                    observed_seconds,
                },
            );
        }
        self.tracks.retain(|_, track| track.tick == tick);
        CrowdForecast { people }
    }
}

impl CrowdForecast {
    #[cfg(test)]
    pub(super) fn stationary(positions: &[Point]) -> Self {
        Self {
            people: positions
                .iter()
                .map(|&position| Prediction {
                    position,
                    velocity: ZERO,
                    confidence: 0.0,
                    future: [Some(position); 3],
                })
                .collect(),
        }
    }

    /// Positive, additive edge costs keep graph search and waypoint shortcuts
    /// consistent. Fast traffic in the route's direction receives a discount;
    /// slow or opposing traffic does not. Forecasts blend in after observation.
    pub(super) fn cost(&self, start: Point, end: Point, radius: f64) -> f64 {
        let length = math::distance_to_point(start, end);
        if length <= math::EPSILON || radius <= 0.0 {
            return 0.0;
        }
        let heading = Point {
            x: (end.x - start.x) / length,
            y: (end.y - start.y) / length,
        };
        self.people
            .iter()
            .map(|person| {
                let current = occupancy_cost(start, heading, length, person.position, radius);
                if person.confidence == 0.0 {
                    return current;
                }
                let forward_speed = (person.velocity.x * heading.x + person.velocity.y * heading.y)
                    .clamp(0.0, WALKING_SPEED)
                    / WALKING_SPEED;
                let predicted = 0.2 * current
                    + person
                        .future
                        .iter()
                        .zip(FORECAST_WEIGHTS)
                        .filter_map(|(position, weight)| {
                            position
                                .map(|p| weight * occupancy_cost(start, heading, length, p, radius))
                        })
                        .sum::<f64>();
                (1.0 - person.confidence) * current
                    + person.confidence * (1.0 - 0.7 * forward_speed) * predicted
            })
            .sum()
    }
}

fn occupancy_cost(start: Point, heading: Point, length: f64, position: Point, radius: f64) -> f64 {
    let x = position.x - start.x;
    let y = position.y - start.y;
    let along = x * heading.x + y * heading.y;
    let across = x * heading.y - y * heading.x;
    let half_squared = (4.0 * radius).powi(2) - across * across;
    if half_squared <= 0.0 {
        return 0.0;
    }
    let half = half_squared.sqrt();
    ((along + half).min(length) - (along - half).max(0.0)).max(0.0) * 2.0
}

pub(super) struct RouteEstimate<'a> {
    pub exit_id: &'a str,
    pub waypoints: &'a [Point],
    pub cost: f64,
}

struct PendingChoice {
    exit_id: String,
    direction: Point,
    since: f64,
}

#[derive(Default)]
pub(super) struct RouteCommitment {
    last_switch: Option<f64>,
    pending: Option<PendingChoice>,
}

impl RouteCommitment {
    /// Geometry changes bypass patience: a known closed passage or invalid
    /// route must be replaced immediately, then congestion guidance settles.
    pub(super) fn forced(&mut self, now: f64) {
        self.last_switch = Some(now);
        self.pending = None;
    }

    pub(super) fn consider(
        &mut self,
        now: f64,
        from: Point,
        current: RouteEstimate<'_>,
        candidate: RouteEstimate<'_>,
        radius: f64,
    ) -> bool {
        let heading = |points: &[Point]| {
            points.iter().find_map(|&point| {
                let distance = math::distance_to_point(from, point);
                (distance > math::EPSILON).then(|| Point {
                    x: (point.x - from.x) / distance,
                    y: (point.y - from.y) / distance,
                })
            })
        };
        let Some(direction) = heading(candidate.waypoints) else {
            self.pending = None;
            return false;
        };
        let reversing = heading(current.waypoints)
            .is_some_and(|current| current.x * direction.x + current.y * direction.y < 0.0);
        // Turning back has a travel cost of its own, beyond the usual saving
        // threshold. This applies to detours to the same exit as well.
        let turn_cost = if reversing {
            TURN_BACK_SECONDS * WALKING_SPEED
        } else {
            0.0
        };
        if !navigation::materially_better(candidate.cost + turn_cost, current.cost, radius) {
            self.pending = None;
            return false;
        }
        let consistent = self.pending.as_ref().is_some_and(|pending| {
            pending.exit_id == candidate.exit_id
                && pending.direction.x * direction.x + pending.direction.y * direction.y >= 0.8
        });
        if !consistent {
            self.pending = Some(PendingChoice {
                exit_id: candidate.exit_id.into(),
                direction,
                since: now,
            });
            return false;
        }
        let confirmed = now - self.pending.as_ref().unwrap().since >= ROUTE_CONFIRM_SECONDS;
        let committed = self
            .last_switch
            .is_some_and(|last| now - last < ROUTE_COMMIT_SECONDS);
        if !confirmed || committed {
            return false;
        }
        self.forced(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::BuildingScenario;

    fn open_space() -> BuildingScenario {
        let mut scenario: BuildingScenario =
            serde_json::from_str(include_str!("../../../shared/examples/building.json")).unwrap();
        scenario.walls.clear();
        scenario.doors.clear();
        scenario.exits.clear();
        scenario.obstructions.clear();
        scenario.blocked_exit_ids.clear();
        scenario
    }

    fn moving_forecast(velocity: Point) -> CrowdForecast {
        let scenario = open_space();
        let geometry = Geometry::new(&scenario);
        let mut memory = CrowdMemory::default();
        let mut forecast = CrowdForecast::default();
        for tick in 0..=20 {
            let remaining = 2.0 - tick as f64 * 0.1;
            forecast = memory.observe(
                &[(
                    7,
                    Point {
                        x: 15.0 - remaining * velocity.x,
                        y: 10.0 - remaining * velocity.y,
                    },
                )],
                tick,
                0.1,
                &geometry,
            );
        }
        forecast
    }

    #[test]
    fn measured_fast_flow_costs_less_than_slow_flow_or_a_stopped_queue() {
        let from = Point { x: 2.0, y: 10.0 };
        let to = Point { x: 28.0, y: 10.0 };
        let stopped = moving_forecast(ZERO).cost(from, to, 0.2);
        let slow = moving_forecast(Point { x: 0.2, y: 0.0 }).cost(from, to, 0.2);
        let fast = moving_forecast(Point {
            x: WALKING_SPEED,
            y: 0.0,
        })
        .cost(from, to, 0.2);
        let opposing = moving_forecast(Point {
            x: -WALKING_SPEED,
            y: 0.0,
        })
        .cost(from, to, 0.2);
        assert!(fast < slow && slow < stopped);
        assert!(
            opposing > 2.0 * fast,
            "opposing traffic must not receive a flow discount"
        );
        assert!(fast > 0.0, "moving people still occupy space");
    }

    #[test]
    fn forecasts_keep_additive_costs_across_waypoint_shortcuts() {
        let forecast = moving_forecast(Point { x: 0.8, y: 0.0 });
        let from = Point { x: 2.0, y: 10.0 };
        let middle = Point { x: 15.0, y: 10.0 };
        let to = Point { x: 28.0, y: 10.0 };
        assert!(
            (forecast.cost(from, to, 0.2)
                - forecast.cost(from, middle, 0.2)
                - forecast.cost(middle, to, 0.2))
            .abs()
                < 1e-9
        );
    }

    #[test]
    fn first_sight_and_lost_sight_do_not_inherit_hidden_velocity() {
        let scenario = open_space();
        let geometry = Geometry::new(&scenario);
        let mut memory = CrowdMemory::default();
        let first = memory.observe(&[(7, Point { x: 10.0, y: 10.0 })], 0, 0.1, &geometry);
        assert_eq!(first.people[0].confidence, 0.0);
        let moving = memory.observe(&[(7, Point { x: 10.1, y: 10.0 })], 1, 0.1, &geometry);
        assert!(moving.people[0].confidence > 0.0 && moving.people[0].velocity.x > 0.0);
        memory.observe(&[], 2, 0.1, &geometry);
        assert!(memory.tracks.is_empty());
        let reappeared = memory.observe(&[(7, Point { x: 11.0, y: 10.0 })], 3, 0.1, &geometry);
        assert_eq!(reappeared.people[0].confidence, 0.0);
        assert_eq!(reappeared.people[0].velocity.x, 0.0);
        let mut stranger = CrowdMemory::default();
        assert_eq!(
            stranger
                .observe(&[(7, Point { x: 11.0, y: 10.0 })], 3, 0.1, &geometry)
                .people[0]
                .confidence,
            0.0
        );
    }

    #[test]
    fn stopping_traffic_loses_its_flow_discount_instead_of_using_stale_speed() {
        let scenario = open_space();
        let geometry = Geometry::new(&scenario);
        let mut memory = CrowdMemory::default();
        let from = Point { x: 2.0, y: 10.0 };
        let to = Point { x: 28.0, y: 10.0 };
        let mut flowing_cost = 0.0;
        let mut stopped_cost = 0.0;
        for tick in 0..=40 {
            let position = Point {
                x: 13.0 + (tick.min(20) as f64 * 0.1),
                y: 10.0,
            };
            let forecast = memory.observe(&[(7, position)], tick, 0.1, &geometry);
            if tick == 20 {
                flowing_cost = forecast.cost(from, to, 0.2);
            }
            if tick == 40 {
                stopped_cost = forecast.cost(from, to, 0.2);
            }
        }
        assert!(stopped_cost > 1.8 * flowing_cost);
        let stationary =
            CrowdForecast::stationary(&[Point { x: 15.0, y: 10.0 }]).cost(from, to, 0.2);
        assert!(stopped_cost > stationary * 0.95);
    }

    fn estimate<'a>(exit_id: &'a str, waypoints: &'a [Point], cost: f64) -> RouteEstimate<'a> {
        RouteEstimate {
            exit_id,
            waypoints,
            cost,
        }
    }

    #[test]
    fn transient_or_alternating_advantages_do_not_switch_guidance() {
        let forward = [Point { x: 10.0, y: 0.0 }];
        let left = [Point { x: 0.0, y: 10.0 }];
        let right = [Point { x: 0.0, y: -10.0 }];
        let mut commitment = RouteCommitment::default();
        for tick in 0..10 {
            let (exit, route) = if tick % 2 == 0 {
                ("left", &left)
            } else {
                ("right", &right)
            };
            assert!(!commitment.consider(
                tick as f64 * 2.0,
                ZERO,
                estimate("current", &forward, 20.0),
                estimate(exit, route, 5.0),
                0.2
            ));
        }
        for tick in 10..20 {
            let cost = if tick % 2 == 0 { 5.0 } else { 19.0 };
            assert!(!commitment.consider(
                tick as f64 * 2.0,
                ZERO,
                estimate("current", &forward, 20.0),
                estimate("left", &left, cost),
                0.2
            ));
        }
    }

    #[test]
    fn sustained_congestion_can_reroute_but_cannot_immediately_switch_back() {
        let north = [Point { x: 0.0, y: 10.0 }];
        let east = [Point { x: 10.0, y: 0.0 }];
        let mut commitment = RouteCommitment::default();
        let mut choose_east = |now| {
            commitment.consider(
                now,
                ZERO,
                estimate("north", &north, 20.0),
                estimate("east", &east, 5.0),
                0.2,
            )
        };
        assert!(!choose_east(0.0));
        assert!(choose_east(2.0));
        let mut choose_north = |now| {
            commitment.consider(
                now,
                ZERO,
                estimate("east", &east, 20.0),
                estimate("north", &north, 5.0),
                0.2,
            )
        };
        assert!(!choose_north(2.1));
        assert!(!choose_north(3.5));
        assert!(
            choose_north(6.0),
            "a persistently worse route must eventually be abandoned"
        );
    }

    #[test]
    fn turning_back_requires_a_larger_saving_even_for_the_same_exit() {
        let forward = [Point { x: 10.0, y: 0.0 }];
        let reverse = [Point { x: -10.0, y: 0.0 }];
        let mut commitment = RouteCommitment::default();
        for now in [0.0, 2.0, 4.0] {
            assert!(!commitment.consider(
                now,
                ZERO,
                estimate("exit", &forward, 20.0),
                estimate("exit", &reverse, 16.0),
                0.2
            ));
        }
        assert!(!commitment.consider(
            6.0,
            ZERO,
            estimate("exit", &forward, 20.0),
            estimate("exit", &reverse, 5.0),
            0.2
        ));
        assert!(commitment.consider(
            8.0,
            ZERO,
            estimate("exit", &forward, 20.0),
            estimate("exit", &reverse, 5.0),
            0.2
        ));
    }
}
