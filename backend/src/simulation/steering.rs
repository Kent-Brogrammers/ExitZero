use super::math;
use crate::models::Point;

/// Persistent side preference prevents choosing a different side every tick.
pub(super) struct Steering {
    preferred_side: f64,
    blocked_ticks: u32,
    target: Option<Point>,
    best_distance: f64,
}

impl Steering {
    pub(super) fn new(id: u32, seed: u64) -> Self {
        Self {
            preferred_side: if seed.wrapping_add(u64::from(id)) & 1 == 0 {
                1.0
            } else {
                -1.0
            },
            blocked_ticks: 0,
            target: None,
            best_distance: f64::INFINITY,
        }
    }

    /// Track useful progress toward the waypoint, rather than treating every
    /// tiny sideways movement as recovery. Oscillating agents still get help.
    pub(super) fn observe(&mut self, position: Point, target: Point, budget: f64) {
        let distance = math::distance_to_point(position, target);
        let changed = self
            .target
            .is_none_or(|old| math::distance_to_point(old, target) > math::EPSILON);
        if changed || distance < self.best_distance - budget * 0.1 {
            self.target = Some(target);
            self.best_distance = distance;
            self.blocked_ticks = 0;
        } else {
            self.blocked_ticks = self.blocked_ticks.saturating_add(1);
        }
    }

    /// Allow normal queues to wait before trying shorter and sideways steps.
    /// Each path still needs geometry and swept collision checks by the caller.
    pub(super) fn candidates(
        &self,
        from: Point,
        target: Point,
        budget: f64,
        retry_ticks: u32,
    ) -> Vec<Point> {
        let distance = math::distance_to_point(from, target);
        if distance <= math::EPSILON {
            return vec![target];
        }
        let mut candidates = Vec::with_capacity(22);
        if self.blocked_ticks < retry_ticks {
            return vec![math::move_toward(from, target, budget)];
        }
        let dx = (target.x - from.x) / distance;
        let dy = (target.y - from.y) / distance;
        // Recovery may need to step away from a crowded corner, not just slide
        // toward it. Do not shrink all recovery steps to a tiny waypoint gap.
        let step = budget;
        // Periodically yield backwards after sustained failure to get closer.
        // Prefer retreat during that interval, even if a tiny forward nudge fits.
        let yielding =
            self.blocked_ticks >= 2 * retry_ticks && (self.blocked_ticks / retry_ticks) % 3 == 2;
        if !yielding {
            for fraction in [1.0, 0.5, 0.25] {
                candidates.push(math::move_toward(from, target, budget * fraction));
            }
        }
        let angles = if yielding {
            [180.0_f64, 150.0, 120.0, 90.0, 60.0, 30.0]
        } else {
            [30.0_f64, 60.0, 90.0, 120.0, 150.0, 180.0]
        };
        for degrees in angles {
            let (sin, cos) = (degrees.to_radians() * self.preferred_side).sin_cos();
            for fraction in [1.0, 0.5, 0.25] {
                candidates.push(Point {
                    x: from.x + step * fraction * (dx * cos - dy * sin),
                    y: from.y + step * fraction * (dx * sin + dy * cos),
                });
            }
        }
        candidates
    }

    pub(super) fn waited(&mut self, retry_ticks: u32) {
        // Keep the current side through a recovery interval before switching.
        if self.blocked_ticks >= 2 * retry_ticks && self.blocked_ticks % retry_ticks == 0 {
            self.preferred_side = -self.preferred_side;
        }
    }

    pub(super) fn needs_replan(&self, retry_ticks: u32) -> bool {
        self.blocked_ticks >= retry_ticks && self.blocked_ticks % retry_ticks == 0
    }
}
