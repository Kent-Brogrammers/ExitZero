use super::{Point, SpawnZone};

const EPS: f64 = 1e-8;
fn area(ring: &[Point]) -> f64 {
    ring.iter()
        .zip(ring.iter().cycle().skip(1))
        .take(ring.len())
        .map(|(p, q)| p.x * q.y - p.y * q.x)
        .sum::<f64>()
        / 2.0
}
fn edges(ring: &[Point]) -> impl Iterator<Item = (Point, Point)> + '_ {
    ring.iter()
        .copied()
        .zip(ring.iter().copied().cycle().skip(1))
        .take(ring.len())
}
fn distance(p: Point, a: Point, b: Point) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let square = dx * dx + dy * dy;
    let t = if square > 0.0 {
        (((p.x - a.x) * dx + (p.y - a.y) * dy) / square).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (p.x - a.x - t * dx).hypot(p.y - a.y - t * dy)
}
fn cross(a: Point, b: Point, c: Point) -> f64 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}
fn intersect(a: Point, b: Point, c: Point, d: Point, touching: bool) -> bool {
    (cross(a, b, c) * cross(a, b, d) < -EPS * EPS && cross(c, d, a) * cross(c, d, b) < -EPS * EPS)
        || (touching
            && (distance(a, c, d) < EPS
                || distance(b, c, d) < EPS
                || distance(c, a, b) < EPS
                || distance(d, a, b) < EPS))
}
fn contains(ring: &[Point], p: Point, boundary: bool) -> bool {
    let mut inside = false;
    for (a, b) in edges(ring) {
        if distance(p, a, b) < EPS {
            return boundary;
        }
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside = !inside;
        }
    }
    inside
}
fn simple(ring: &[Point]) -> bool {
    (3..=512).contains(&ring.len())
        && area(ring).abs() > EPS
        && ring.iter().all(|p| p.x.is_finite() && p.y.is_finite())
        && edges(ring).enumerate().all(|(i, (a, b))| {
            (a.x - b.x).hypot(a.y - b.y) > EPS
                && edges(ring).enumerate().all(|(j, (c, d))| {
                    i == j
                        || j == (i + 1) % ring.len()
                        || i == (j + 1) % ring.len()
                        || !intersect(a, b, c, d, true)
                })
        })
}

impl SpawnZone {
    fn ring(&self) -> Vec<Point> {
        self.polygon.clone().unwrap_or_else(|| {
            vec![
                Point {
                    x: self.x,
                    y: self.y,
                },
                Point {
                    x: self.x + self.width,
                    y: self.y,
                },
                Point {
                    x: self.x + self.width,
                    y: self.y + self.height,
                },
                Point {
                    x: self.x,
                    y: self.y + self.height,
                },
            ]
        })
    }
    fn rings(&self) -> Vec<Vec<Point>> {
        let mut rings = vec![self.ring()];
        rings.extend(self.holes.clone());
        rings
    }
    pub fn area(&self) -> f64 {
        self.polygon
            .as_ref()
            .map_or(self.width * self.height, |ring| area(ring).abs())
            - self.holes.iter().map(|ring| area(ring).abs()).sum::<f64>()
    }
    fn contains(&self, p: Point, boundary: bool) -> bool {
        self.polygon.as_ref().map_or_else(
            || {
                let margin = if boundary { -EPS } else { EPS };
                p.x > self.x + margin
                    && p.x < self.x + self.width - margin
                    && p.y > self.y + margin
                    && p.y < self.y + self.height - margin
            },
            |ring| contains(ring, p, boundary),
        ) && !self.holes.iter().any(|h| contains(h, p, true))
    }
    pub fn contains_disc(&self, p: Point, radius: f64) -> bool {
        if self.polygon.is_none() {
            return p.x >= self.x + radius - EPS
                && p.x <= self.x + self.width - radius + EPS
                && p.y >= self.y + radius - EPS
                && p.y <= self.y + self.height - radius + EPS;
        }
        self.contains(p, true)
            && self
                .polygon
                .iter()
                .chain(self.holes.iter())
                .all(|ring| edges(ring).all(|(a, b)| distance(p, a, b) + EPS >= radius))
    }
    pub(super) fn validate_polygon(&self) -> Result<(), String> {
        let Some(outer) = &self.polygon else {
            return if self.holes.is_empty() {
                Ok(())
            } else {
                Err("spawn holes require a polygon boundary".into())
            };
        };
        let rings = self.rings();
        if self.holes.len() > 32 || !rings.iter().all(|ring| simple(ring)) {
            return Err("spawn polygons need simple nonintersecting boundaries of 3-512 vertices, with at most 32 holes".into());
        }
        let min_x = outer.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
        let min_y = outer.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
        let max_x = outer.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
        let max_y = outer.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
        if [
            (min_x, self.x),
            (min_y, self.y),
            (max_x - min_x, self.width),
            (max_y - min_y, self.height),
        ]
        .iter()
        .any(|(a, b)| (a - b).abs() > EPS)
        {
            return Err("spawn polygon bounds must match its vertices".into());
        }
        for i in 1..rings.len() {
            let hole = &rings[i];
            if !hole.iter().all(|&p| contains(outer, p, false)) {
                return Err("spawn holes must lie strictly inside their polygon".into());
            }
            for (j, other) in rings[..i].iter().enumerate() {
                if edges(hole).any(|(a, b)| edges(other).any(|(c, d)| intersect(a, b, c, d, true)))
                    || (j > 0 && (contains(other, hole[0], true) || contains(hole, other[0], true)))
                {
                    return Err("spawn holes must not touch or overlap other boundaries".into());
                }
            }
        }
        Ok(())
    }
    /// Shared edges are permitted; intersecting interiors are not.
    pub(super) fn overlaps(&self, other: &Self) -> bool {
        if self.x >= other.x + other.width - EPS
            || other.x >= self.x + self.width - EPS
            || self.y >= other.y + other.height - EPS
            || other.y >= self.y + self.height - EPS
        {
            return false;
        }
        if self.polygon.is_none() && other.polygon.is_none() {
            return true;
        }
        let ar = self.rings();
        let br = other.rings();
        if ar.iter().any(|r| {
            edges(r).any(|(a, b)| {
                br.iter()
                    .any(|s| edges(s).any(|(c, d)| intersect(a, b, c, d, false)))
            })
        }) {
            return true;
        }
        [(self, other), (other, self)]
            .iter()
            .any(|(source, target)| {
                source.rings().iter().any(|r| {
                    edges(r).any(|(p, q)| {
                        if target.contains(p, false) {
                            return true;
                        }
                        let length = (q.x - p.x).hypot(q.y - p.y);
                        let offset = (length * 1e-4).min(1e-6);
                        [-1.0, 1.0].iter().any(|sign| {
                            let sample = Point {
                                x: (p.x + q.x) / 2.0 - sign * (q.y - p.y) / length * offset,
                                y: (p.y + q.y) / 2.0 + sign * (q.x - p.x) / length * offset,
                            };
                            source.contains(sample, false) && target.contains(sample, false)
                        })
                    })
                })
            })
    }
}
