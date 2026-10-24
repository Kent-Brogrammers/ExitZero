//! Geometry primitives in metres. Inputs must be finite; rectangle dimensions,
//! radii, and movement distances must be nonnegative. Polygons are simple,
//! ordered boundaries without holes. Curves are supplied as flattened polylines.
use crate::models::Point;

pub(super) const EPSILON: f64 = 1e-9;

/// Point along a segment; t is clamped to [0, 1].
pub(super) fn interpolate(start: Point, end: Point, t: f64) -> Point {
    let t = t.clamp(0.0, 1.0);
    Point {
        x: start.x + t * (end.x - start.x),
        y: start.y + t * (end.y - start.y),
    }
}

/// Move by at most max_distance, stopping at the target without overshooting.
pub(super) fn move_toward(start: Point, target: Point, max_distance: f64) -> Point {
    let distance = distance_to_point(start, target);
    if distance == 0.0 {
        return start;
    }
    interpolate(start, target, max_distance.max(0.0) / distance)
}

/// Closest point on a segment, including either endpoint.
pub(super) fn closest_point_on_segment(point: Point, start: Point, end: Point) -> Point {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let length_squared = dx * dx + dy * dy;
    if length_squared == 0.0 {
        return start;
    }
    let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / length_squared;
    interpolate(start, end, t)
}

/// Corners of a rectangle rotated around its centre by angle_radians.
/// In screen coordinates (y down), positive angles appear clockwise.
pub(super) fn rectangle_vertices(
    center: Point,
    width: f64,
    height: f64,
    angle_radians: f64,
) -> [Point; 4] {
    let (sin, cos) = angle_radians.sin_cos();
    [
        (-width / 2.0, -height / 2.0),
        (width / 2.0, -height / 2.0),
        (width / 2.0, height / 2.0),
        (-width / 2.0, height / 2.0),
    ]
    .map(|(x, y)| Point {
        x: center.x + x * cos - y * sin,
        y: center.y + x * sin + y * cos,
    })
}

/// Minimum distance from a movement segment to an open polyline.
/// Empty paths have infinite distance; a single vertex is a point.
pub(super) fn distance_segment_to_polyline(start: Point, end: Point, points: &[Point]) -> f64 {
    match points {
        [] => f64::INFINITY,
        [only] => distance_to_segment(*only, start, end),
        _ => points
            .windows(2)
            .map(|edge| distance_between_segments(start, end, edge[0], edge[1]))
            .fold(f64::INFINITY, f64::min),
    }
}

/// Distance from a movement segment to a filled polygon; zero if it enters,
/// crosses, or touches the shape. Empty polygons have infinite distance.
pub(super) fn distance_segment_to_polygon(start: Point, end: Point, vertices: &[Point]) -> f64 {
    if point_in_polygon(start, vertices) || point_in_polygon(end, vertices) {
        return 0.0;
    }
    let mut distance = distance_segment_to_polyline(start, end, vertices);
    if let (Some(&first), Some(&last)) = (vertices.first(), vertices.last()) {
        distance = distance.min(distance_between_segments(start, end, last, first));
    }
    distance
}

/// Distance from a movement segment to a filled axis-aligned rectangle.
pub(super) fn distance_segment_to_rectangle(
    start: Point,
    end: Point,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> f64 {
    let vertices = rectangle_vertices(
        Point {
            x: x + width / 2.0,
            y: y + height / 2.0,
        },
        width,
        height,
        0.0,
    );
    distance_segment_to_polygon(start, end, &vertices)
}

/// Disc overlap; exact tangency is permitted, matching the clearance checks.
pub(super) fn circles_overlap(a: Point, a_radius: f64, b: Point, b_radius: f64) -> bool {
    distance_to_point(a, b) < a_radius + b_radius
}

/// Whether two discs overlap at any time during simultaneous linear moves.
/// This compares relative positions at equal times, rather than just checking
/// whether their geometric paths cross at potentially different times.
pub(super) fn moving_circles_overlap(
    a_start: Point,
    a_end: Point,
    a_radius: f64,
    b_start: Point,
    b_end: Point,
    b_radius: f64,
) -> bool {
    let relative_start = Point {
        x: a_start.x - b_start.x,
        y: a_start.y - b_start.y,
    };
    let relative_end = Point {
        x: a_end.x - b_end.x,
        y: a_end.y - b_end.y,
    };
    distance_to_segment(Point { x: 0.0, y: 0.0 }, relative_start, relative_end)
        < a_radius + b_radius
}

/// Shortest distance between two finite segments with finite coordinates.
/// Crossing, touching, or overlapping segments have zero distance.
/// Either segment may have identical endpoints.
pub(super) fn distance_between_segments(
    a_start: Point,
    a_end: Point,
    b_start: Point,
    b_end: Point,
) -> f64 {
    let b_start_side = orientation(a_start, a_end, b_start);
    let b_end_side = orientation(a_start, a_end, b_end);
    let a_start_side = orientation(b_start, b_end, a_start);
    let a_end_side = orientation(b_start, b_end, a_end);

    // A proper crossing puts each segment's endpoints on opposite sides
    // of the other segment's line. No endpoint-distance check detects this.
    let b_straddles_a =
        (b_start_side < 0.0 && b_end_side > 0.0) || (b_start_side > 0.0 && b_end_side < 0.0);
    let a_straddles_b =
        (a_start_side < 0.0 && a_end_side > 0.0) || (a_start_side > 0.0 && a_end_side < 0.0);
    if b_straddles_a && a_straddles_b {
        return 0.0;
    }

    // Otherwise the closest pair includes an endpoint. This also handles
    // touching endpoints, collinear overlap, and zero-length segments.
    distance_to_segment(a_start, b_start, b_end)
        .min(distance_to_segment(a_end, b_start, b_end))
        .min(distance_to_segment(b_start, a_start, a_end))
        .min(distance_to_segment(b_end, a_start, a_end))
}

// Signed cross product: which side of the directed line the point lies on.
fn orientation(start: Point, end: Point, point: Point) -> f64 {
    (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x)
}

//Primitive operation - Finding distance between two points
pub(super) fn distance_to_point(start: Point, end: Point) -> f64 {
    (end.x - start.x).hypot(end.y - start.y)
}

// Distance to a filled axis-aligned rectangle; zero for points inside it.
pub(super) fn distance_to_rectangle(point: Point, x: f64, y: f64, width: f64, height: f64) -> f64 {
    let vertices = [
        Point { x, y },
        Point { x: x + width, y },
        Point {
            x: x + width,
            y: y + height,
        },
        Point { x, y: y + height },
    ];
    distance_to_polygon(point, &vertices)
}

/// Whether a point is inside or on the boundary of a simple polygon.
/// Vertices must be finite and ordered around the boundary, without holes
/// or self-intersections. The last vertex connects back to the first.
pub(super) fn point_in_polygon(point: Point, vertices: &[Point]) -> bool {
    if vertices.len() < 3 {
        return false;
    }

    let mut inside = false;
    for i in 0..vertices.len() {
        let start = vertices[i];
        let end = vertices[(i + 1) % vertices.len()];

        // Include the boundary, allowing a small tolerance in metres.
        if distance_to_segment(point, start, end) <= EPSILON {
            return true;
        }

        // A horizontal ray toggles inside/outside at each crossing. This
        // condition skips horizontal edges and counts shared vertices once.
        if (start.y > point.y) != (end.y > point.y) {
            let crossing_x = start.x + (point.y - start.y) / (end.y - start.y) * (end.x - start.x);
            if point.x < crossing_x {
                inside = !inside;
            }
        }
    }
    inside
}

/// Distance to a filled polygon, zero inside or on its boundary.
/// Supports convex and concave simple polygons with ordered finite vertices.
/// Empty input has infinite distance; one/two vertices are a point/segment.
pub(super) fn distance_to_polygon(point: Point, vertices: &[Point]) -> f64 {
    if point_in_polygon(point, vertices) {
        return 0.0;
    }

    let mut distance = distance_to_polyline(point, vertices);
    if let (Some(&first), Some(&last)) = (vertices.first(), vertices.last()) {
        distance = distance.min(distance_to_segment(point, last, first));
    }
    distance
}

/// Distance to an open chain of finite points; does not close the last edge.
/// Curves must first be approximated as line segments by the caller.
/// Empty input has infinite distance; a single vertex is treated as a point.
pub(super) fn distance_to_polyline(point: Point, points: &[Point]) -> f64 {
    match points {
        [] => f64::INFINITY,
        [only] => distance_to_point(point, *only),
        _ => points
            .windows(2)
            .map(|edge| distance_to_segment(point, edge[0], edge[1]))
            .fold(f64::INFINITY, f64::min),
    }
}

// Find the shortest distance from a point to a finite segment.
pub(super) fn distance_to_segment(point: Point, start: Point, end: Point) -> f64 {
    distance_to_point(point, closest_point_on_segment(point, start, end))
}
