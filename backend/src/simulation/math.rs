use crate::models::Point;

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
        if distance_to_segment(point, start, end) <= 1e-9 {
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
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let length_squared = dx * dx + dy * dy;

    // Identical endpoints form a point, so avoid dividing by zero.
    if length_squared == 0.0 {
        return distance_to_point(point, start);
    }

    // Project onto the line and clamp to the segment's endpoints.
    let t =
        (((point.x - start.x) * dx + (point.y - start.y) * dy) / length_squared).clamp(0.0, 1.0);
    let closest = Point {
        x: start.x + t * dx,
        y: start.y + t * dy,
    };

    distance_to_point(point, closest)
}
