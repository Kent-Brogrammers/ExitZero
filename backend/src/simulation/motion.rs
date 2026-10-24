use super::math;
use crate::models::Point;

pub(super) const WALKING_SPEED: f64 = 1.3;
pub(super) const ACCELERATION: f64 = 2.0;
const HORIZON: f64 = 1.5;
const ZERO: Point = Point { x: 0.0, y: 0.0 };

#[derive(Clone, Copy)]
pub(super) struct Neighbor {
    pub position: Point,
    pub velocity: Point,
    pub responsibility: f64,
    pub horizon: f64,
}

/// The permitted side of a line in velocity space: normal dot velocity >= offset.
#[derive(Clone, Copy)]
pub(super) struct VelocityLimit {
    pub normal: Point,
    pub offset: f64,
}

pub(super) struct Motion {
    velocity: Point,
}

impl Motion {
    pub(super) fn new() -> Self {
        Self { velocity: ZERO }
    }

    pub(super) fn velocity(&self) -> Point {
        self.velocity
    }

    pub(super) fn accepted(&mut self, from: Point, to: Point, dt: f64) {
        self.velocity = scale(sub(to, from), 1.0 / dt);
    }

    /// A smooth intent, sensed by every controller before any position changes.
    pub(super) fn preferred_velocity(
        &self,
        from: Point,
        target: Point,
        dt: f64,
        radius: f64,
        neighbors: &[Neighbor],
        limits: &[VelocityLimit],
    ) -> Point {
        let delta = sub(target, from);
        let distance = length(delta);
        let mut preferred = if distance <= math::EPSILON {
            ZERO
        } else {
            scale(delta, WALKING_SPEED.min(distance / dt) / distance)
        };
        // A consistent passing side breaks perfectly symmetric head-on
        // encounters before the reciprocal constraints reduce both to rest.
        // This is a continuous velocity preference, not alternating sidesteps.
        if distance > math::EPSILON {
            let heading = scale(delta, 1.0 / distance);
            let mut passing = 0.0_f64;
            for other in neighbors {
                let separation = sub(other.position, from);
                let relative = sub(preferred, other.velocity);
                let speed_squared = dot(relative, relative);
                if speed_squared <= 1e-12 || dot(heading, separation) <= 0.0 {
                    continue;
                }
                let time = dot(separation, relative) / speed_squared;
                let miss = length(sub(separation, scale(relative, time)));
                if time > 0.0 && time < HORIZON && miss < 2.0 * radius + 0.1 {
                    passing = passing.max(0.25 * (1.0 - miss / (2.0 * radius + 0.1)));
                }
            }
            preferred = add(
                preferred,
                Point {
                    x: -heading.y * passing.min(distance / 0.5),
                    y: heading.x * passing.min(distance / 0.5),
                },
            );
            preferred = math::move_toward(ZERO, preferred, WALKING_SPEED);
        }
        let smooth = math::move_toward(self.velocity, preferred, ACCELERATION * dt);
        closest_velocity(smooth, limits, Some((self.velocity, ACCELERATION * dt)))
            .or_else(|| closest_velocity(smooth, limits, None))
            .unwrap_or(ZERO)
    }

    /// Recomputed every tick from common positions and intended velocities.
    /// Moving people split reciprocal corrections (ORCA, van den Berg et al.,
    /// equations 5–8, using the shared intents as optimization velocities).
    pub(super) fn propose(
        &self,
        from: Point,
        preferred: Point,
        dt: f64,
        radius: f64,
        neighbors: &[Neighbor],
        mut limits: Vec<VelocityLimit>,
    ) -> Point {
        let static_count = limits.len();
        for other in neighbors {
            let separation = sub(other.position, from);
            if length(separation) <= 2.0 * radius + 2.0 * WALKING_SPEED * HORIZON {
                limits.push(reciprocal_limit(
                    preferred,
                    separation,
                    sub(preferred, other.velocity),
                    2.0 * radius + 1e-5,
                    dt,
                    other.horizon.max(dt),
                    other.responsibility,
                ));
            }
        }
        let velocity =
            closest_velocity(preferred, &limits, Some((self.velocity, ACCELERATION * dt)))
                .or_else(|| closest_velocity(preferred, &limits, None))
                // Dense, infeasible configurations still go through joint swept-disc
                // validation. Never describe this fallback as an ORCA guarantee.
                .or_else(|| closest_velocity(preferred, &limits[..static_count], None))
                .unwrap_or(ZERO);
        add(from, scale(velocity, dt))
    }
}

fn reciprocal_limit(
    velocity: Point,
    separation: Point,
    relative_velocity: Point,
    radius: f64,
    dt: f64,
    horizon: f64,
    share: f64,
) -> VelocityLimit {
    let distance_squared = dot(separation, separation);
    let radius_squared = radius * radius;
    let (normal, correction) = if distance_squared > radius_squared {
        let w = sub(relative_velocity, scale(separation, 1.0 / horizon));
        let projection = dot(w, separation);
        if projection < 0.0 && projection * projection > radius_squared * dot(w, w) {
            let normal = scale(w, 1.0 / length(w));
            (normal, scale(normal, radius / horizon - length(w)))
        } else {
            let leg = (distance_squared - radius_squared).sqrt();
            let direction = if cross(separation, w) > 0.0 {
                Point {
                    x: (separation.x * leg - separation.y * radius) / distance_squared,
                    y: (separation.x * radius + separation.y * leg) / distance_squared,
                }
            } else {
                Point {
                    x: -(separation.x * leg + separation.y * radius) / distance_squared,
                    y: (separation.x * radius - separation.y * leg) / distance_squared,
                }
            };
            (
                Point {
                    x: -direction.y,
                    y: direction.x,
                },
                sub(
                    scale(direction, dot(relative_velocity, direction)),
                    relative_velocity,
                ),
            )
        }
    } else {
        let w = sub(relative_velocity, scale(separation, 1.0 / dt));
        let magnitude = length(w);
        let normal = if magnitude > 1e-12 {
            scale(w, 1.0 / magnitude)
        } else {
            scale(separation, -1.0 / length(separation).max(1e-12))
        };
        (normal, scale(normal, radius / dt - magnitude))
    };
    VelocityLimit {
        normal,
        offset: dot(normal, add(velocity, scale(correction, share))),
    }
}

/// Incrementally project onto the boundary of each violated half-plane. Its
/// feasible interval is clipped by earlier lines and the speed/acceleration discs.
/// This is a two-dimensional convex solve, with deterministic constraint order.
fn closest_velocity(
    preferred: Point,
    limits: &[VelocityLimit],
    acceleration: Option<(Point, f64)>,
) -> Option<Point> {
    let mut result = math::move_toward(ZERO, preferred, WALKING_SPEED);
    if let Some((center, radius)) = acceleration {
        result = math::move_toward(center, result, radius);
    }
    for (i, limit) in limits.iter().enumerate() {
        if dot(limit.normal, result) >= limit.offset - 1e-10 {
            continue;
        }
        let base = scale(limit.normal, limit.offset);
        let tangent = Point {
            x: -limit.normal.y,
            y: limit.normal.x,
        };
        let mut interval = (f64::NEG_INFINITY, f64::INFINITY);
        clip_disc(base, tangent, ZERO, WALKING_SPEED, &mut interval)?;
        if let Some((center, radius)) = acceleration {
            clip_disc(base, tangent, center, radius, &mut interval)?;
        }
        for previous in &limits[..i] {
            let rate = dot(previous.normal, tangent);
            let required = previous.offset - dot(previous.normal, base);
            if rate.abs() < 1e-12 {
                if required > 1e-10 {
                    return None;
                }
            } else if rate > 0.0 {
                interval.0 = interval.0.max(required / rate);
            } else {
                interval.1 = interval.1.min(required / rate);
            }
        }
        if interval.0 > interval.1 + 1e-10 {
            return None;
        }
        let t = dot(sub(preferred, base), tangent)
            .max(interval.0)
            .min(interval.1);
        result = add(base, scale(tangent, t));
    }
    Some(result)
}

fn clip_disc(
    base: Point,
    tangent: Point,
    center: Point,
    radius: f64,
    interval: &mut (f64, f64),
) -> Option<()> {
    let relative = sub(base, center);
    let along = dot(relative, tangent);
    let discriminant = along * along + radius * radius - dot(relative, relative);
    if discriminant < -1e-10 {
        return None;
    }
    let half = discriminant.max(0.0).sqrt();
    interval.0 = interval.0.max(-along - half);
    interval.1 = interval.1.min(-along + half);
    (interval.0 <= interval.1 + 1e-10).then_some(())
}

fn add(a: Point, b: Point) -> Point {
    Point {
        x: a.x + b.x,
        y: a.y + b.y,
    }
}
fn sub(a: Point, b: Point) -> Point {
    Point {
        x: a.x - b.x,
        y: a.y - b.y,
    }
}
fn scale(a: Point, amount: f64) -> Point {
    Point {
        x: a.x * amount,
        y: a.y * amount,
    }
}
fn dot(a: Point, b: Point) -> f64 {
    a.x * b.x + a.y * b.y
}
fn cross(a: Point, b: Point) -> f64 {
    a.x * b.y - a.y * b.x
}
fn length(a: Point) -> f64 {
    a.x.hypot(a.y)
}

/// Resolve residual conflicts cooperatively instead of stopping both people.
/// Velocity corrections are projected back onto static geometry and speed
/// constraints. Full swept validation follows; this is not a safety shortcut.
pub(super) fn coordinate_moves(
    before: &[Point],
    proposed: &mut [Point],
    active: &[bool],
    compliance: &[f64],
    radius: f64,
    dt: f64,
    limits: &[Vec<VelocityLimit>],
) {
    for iteration in 0..512 {
        let mut corrected = false;
        for i in 0..before.len() {
            if !active[i] {
                continue;
            }
            for j in i + 1..before.len() {
                if !active[j] {
                    continue;
                }
                let start = sub(before[i], before[j]);
                let displacement = sub(sub(proposed[i], before[i]), sub(proposed[j], before[j]));
                let square = dot(displacement, displacement);
                if square < 1e-20 {
                    continue;
                }
                let time = (-dot(start, displacement) / square).clamp(0.0, 1.0);
                let closest = add(start, scale(displacement, time));
                let separation = length(closest);
                // A time-scaled buffer avoids dividing a fixed safety margin
                // by a near-zero encounter time in tightly packed queues.
                let required = 2.0 * radius + 1e-4 * time;
                if separation >= required || time < 1e-9 {
                    continue;
                }
                let normal = if separation > 1e-10 {
                    scale(closest, 1.0 / separation)
                } else {
                    let size = length(start);
                    Point {
                        x: -start.y / size,
                        y: start.x / size,
                    }
                };
                let correction = (required - separation) / time;
                let total = compliance[i] + compliance[j];
                if total == 0.0 {
                    continue;
                }
                for (k, share) in [(i, compliance[i] / total), (j, -compliance[j] / total)] {
                    if share == 0.0 {
                        continue;
                    }
                    let wanted = add(
                        scale(sub(proposed[k], before[k]), 1.0 / dt),
                        scale(normal, correction * share / dt),
                    );
                    if let Some(velocity) = closest_velocity(wanted, &limits[k], None) {
                        proposed[k] = add(before[k], scale(velocity, dt));
                    }
                }
                corrected = true;
            }
        }
        let safe = iteration % 4 == 3
            && (0..before.len()).all(|i| {
                !active[i]
                    || (i + 1..before.len()).all(|j| {
                        !active[j]
                            || !math::moving_circles_overlap(
                                before[i],
                                proposed[i],
                                radius,
                                before[j],
                                proposed[j],
                                radius,
                            )
                    })
            });
        if !corrected || safe {
            break;
        }
    }
}

/// Validate simultaneous trajectories, including people who will leave this
/// tick. Stopping one proposal can invalidate another, so propagate stops until
/// every swept path is safe. Every pass stops at least one moving agent.
pub(super) fn resolve_collisions(
    before: &[Point],
    proposed: &mut [Point],
    active: &[bool],
    radius: f64,
) {
    loop {
        let mut changed = false;
        for i in 0..before.len() {
            if !active[i] {
                continue;
            }
            for j in i + 1..before.len() {
                if !active[j]
                    || !math::moving_circles_overlap(
                        before[i],
                        proposed[i],
                        radius,
                        before[j],
                        proposed[j],
                        radius,
                    )
                {
                    continue;
                }
                for k in [i, j] {
                    if math::distance_to_point(before[k], proposed[k]) > 0.0 {
                        proposed[k] = before[k];
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }
}
