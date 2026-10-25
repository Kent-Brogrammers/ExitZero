//! Conservative visible wall portions in metres. An interval is remembered only
//! when its entire sight triangle is clear. Uncertain sub-centimetre slivers are
//! omitted, never expanded into unseen geometry. This is not a navigation grid.
use std::{cmp::Ordering, collections::BTreeMap};

use super::math;
use crate::models::Point;

#[derive(Debug, Clone, Copy)]
pub(super) struct WallSpan {
    pub start: f64,
    pub end: f64,
}

impl PartialEq for WallSpan {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for WallSpan {}
impl PartialOrd for WallSpan {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for WallSpan {
    fn cmp(&self, other: &Self) -> Ordering {
        self.start
            .total_cmp(&other.start)
            .then_with(|| self.end.total_cmp(&other.end))
    }
}

pub(super) type WallKnowledge = BTreeMap<String, Vec<WallSpan>>;

/// Union only overlapping observed intervals. Separate visible patches must
/// never imply knowledge of the occluded space between them.
pub(super) fn remember(known: &mut WallKnowledge, report: &WallKnowledge) -> bool {
    let mut changed = false;
    for (id, spans) in report {
        let remembered = known.entry(id.clone()).or_default();
        let before = remembered.clone();
        remembered.extend(spans);
        remembered.sort();
        let mut merged: Vec<WallSpan> = Vec::new();
        for span in remembered.iter().copied() {
            if let Some(last) = merged.last_mut()
                && span.start <= last.end + math::EPSILON
            {
                last.end = last.end.max(span.end);
            } else {
                merged.push(span);
            }
        }
        changed |= before != merged;
        *remembered = merged;
    }
    changed
}

#[derive(Clone, Copy)]
pub(super) enum Occluder {
    Capsule {
        start: Point,
        end: Point,
        radius: f64,
    },
    Rectangle {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
}

impl Occluder {
    pub(super) fn blocks_ray(self, from: Point, to: Point) -> bool {
        match self {
            Self::Capsule { start, end, radius } => {
                math::distance_between_segments(from, to, start, end) <= radius
            }
            Self::Rectangle {
                x,
                y,
                width,
                height,
            } => {
                math::distance_segment_to_rectangle(from, to, x, y, width, height) <= math::EPSILON
            }
        }
    }

    /// Cheap conservative rejection before ray and polygon intersection work.
    fn overlaps_bounds(self, min: Point, max: Point) -> bool {
        let (left, top, right, bottom) = match self {
            Self::Capsule { start, end, radius } => (
                start.x.min(end.x) - radius,
                start.y.min(end.y) - radius,
                start.x.max(end.x) + radius,
                start.y.max(end.y) + radius,
            ),
            Self::Rectangle {
                x,
                y,
                width,
                height,
            } => (x, y, x + width, y + height),
        };
        left <= max.x + math::EPSILON
            && right >= min.x - math::EPSILON
            && top <= max.y + math::EPSILON
            && bottom >= min.y - math::EPSILON
    }

    fn intersects_triangle(self, triangle: &[Point; 3]) -> bool {
        match self {
            Self::Capsule { start, end, radius } => {
                math::distance_segment_to_polygon(start, end, triangle) <= radius
            }
            Self::Rectangle {
                x,
                y,
                width,
                height,
            } => {
                let corners = [
                    Point { x, y },
                    Point { x: x + width, y },
                    Point {
                        x: x + width,
                        y: y + height,
                    },
                    Point { x, y: y + height },
                ];
                math::point_in_polygon(triangle[0], &corners)
                    || (0..4).any(|i| {
                        math::distance_segment_to_polygon(
                            corners[i],
                            corners[(i + 1) % 4],
                            triangle,
                        ) <= math::EPSILON
                    })
            }
        }
    }
}

/// Visible intervals along one straight, observer-facing wall surface. Sight
/// range is clipped analytically, including between either endpoint.
pub(super) fn visible_intervals(
    from: Point,
    start: Point,
    end: Point,
    range: f64,
    occluders: &[Occluder],
) -> Vec<WallSpan> {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let length_squared = dx * dx + dy * dy;
    if length_squared <= 1e-24 {
        return Vec::new();
    }
    let px = start.x - from.x;
    let py = start.y - from.y;
    let along = px * dx + py * dy;
    let discriminant = along * along - length_squared * (px * px + py * py - range * range);
    if discriminant < 0.0 {
        return Vec::new();
    }
    let half = discriminant.sqrt();
    let left = ((-along - half) / length_squared).max(0.0);
    let right = ((-along + half) / length_squared).min(1.0);
    if left > right {
        return Vec::new();
    }
    let mut visible = Vec::new();
    let mut pending = vec![(left, right, 0_u32)];
    while let Some((left, right, depth)) = pending.pop() {
        let a = math::interpolate(start, end, left);
        let b = math::interpolate(start, end, right);
        let triangle = [from, a, b];
        let min = Point {
            x: from.x.min(a.x).min(b.x),
            y: from.y.min(a.y).min(b.y),
        };
        let max = Point {
            x: from.x.max(a.x).max(b.x),
            y: from.y.max(a.y).max(b.y),
        };
        let mut uncertain = false;
        let mut hidden = false;
        for &obstacle in occluders {
            if !obstacle.overlaps_bounds(min, max) {
                continue;
            }
            // The shadow of a convex obstacle is convex. Both endpoints behind
            // the same obstacle imply that the whole interval is hidden.
            if obstacle.blocks_ray(from, a) && obstacle.blocks_ray(from, b) {
                hidden = true;
                break;
            }
            uncertain |= obstacle.intersects_triangle(&triangle);
        }
        if hidden {
            continue;
        }
        if !uncertain {
            visible.push(WallSpan {
                start: left,
                end: right,
            });
        } else if depth < 18 && math::distance_to_point(a, b) > 0.01 {
            let middle = (left + right) * 0.5;
            pending.push((middle, right, depth + 1));
            pending.push((left, middle, depth + 1));
        }
    }
    visible
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sight_range_clips_a_long_wall_instead_of_revealing_its_ends() {
        let from = Point { x: 10.0, y: 2.0 };
        let seen = visible_intervals(
            from,
            Point { x: 0.0, y: 0.0 },
            Point { x: 20.0, y: 0.0 },
            3.0,
            &[],
        );
        assert_eq!(seen.len(), 1);
        let expected = 5.0_f64.sqrt();
        assert!((seen[0].start * 20.0 - (10.0 - expected)).abs() < 1e-9);
        assert!((seen[0].end * 20.0 - (10.0 + expected)).abs() < 1e-9);
    }

    #[test]
    fn a_sliver_beside_a_screen_does_not_reveal_hidden_wall_material() {
        let screen = Occluder::Rectangle {
            x: 7.0,
            y: 3.0,
            width: 13.0,
            height: 0.1,
        };
        let seen = visible_intervals(
            Point { x: 10.0, y: 5.0 },
            Point { x: 0.0, y: 0.0 },
            Point { x: 20.0, y: 0.0 },
            30.0,
            &[screen],
        );
        assert!(!seen.is_empty(), "the left sliver is visible");
        assert!(seen.iter().all(|span| span.end * 20.0 < 2.11));
        assert!(seen.iter().any(|span| span.end > span.start));
        for span in seen {
            for fraction in [0.0, 0.25, 0.5, 0.75, 1.0] {
                let t = span.start + fraction * (span.end - span.start);
                assert!(!screen.blocks_ray(
                    Point { x: 10.0, y: 5.0 },
                    Point {
                        x: 20.0 * t,
                        y: 0.0
                    }
                ));
            }
        }
    }

    #[test]
    fn separate_visible_patches_keep_the_occluded_gap_unknown() {
        let screen = Occluder::Rectangle {
            x: 9.0,
            y: 3.0,
            width: 2.0,
            height: 0.1,
        };
        let seen = visible_intervals(
            Point { x: 10.0, y: 5.0 },
            Point { x: 0.0, y: 0.0 },
            Point { x: 20.0, y: 0.0 },
            30.0,
            &[screen],
        );
        assert!(seen.iter().any(|span| span.start == 0.0));
        assert!(seen.iter().any(|span| span.end == 1.0));
        assert!(seen.iter().all(|span| span.end < 0.5 || span.start > 0.5));
        let report = BTreeMap::from([("wall".into(), seen)]);
        let mut remembered = WallKnowledge::new();
        assert!(remember(&mut remembered, &report));
        assert!(
            !remember(&mut remembered, &report),
            "repeated reports are idempotent"
        );
        assert_eq!(remembered["wall"].len(), 2);
        assert!(remembered["wall"][0].end < remembered["wall"][1].start);
    }

    #[test]
    fn even_a_very_thin_occluder_keeps_its_shadow_out_of_memory() {
        let screen = Occluder::Capsule {
            start: Point { x: 10.0, y: 1.0 },
            end: Point { x: 10.0, y: 2.0 },
            radius: 1e-10,
        };
        let seen = visible_intervals(
            Point { x: 10.0, y: 5.0 },
            Point { x: 0.0, y: 0.0 },
            Point { x: 20.0, y: 0.0 },
            30.0,
            &[screen],
        );
        assert!(!seen.is_empty());
        assert!(seen.iter().all(|span| span.end < 0.5 || span.start > 0.5));
    }

    #[test]
    fn geometry_beyond_the_target_does_not_hide_it() {
        let screen = Occluder::Rectangle {
            x: 0.0,
            y: -3.0,
            width: 20.0,
            height: 1.0,
        };
        let seen = visible_intervals(
            Point { x: 10.0, y: 5.0 },
            Point { x: 0.0, y: 0.0 },
            Point { x: 20.0, y: 0.0 },
            30.0,
            &[screen],
        );
        assert_eq!(
            seen,
            [WallSpan {
                start: 0.0,
                end: 1.0
            }]
        );
    }
}
