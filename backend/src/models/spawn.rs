use super::{BuildingScenario, Point, SpawnZone};

const EPS: f64 = 1e-7;

pub(super) fn segment_distance(p: Point, a: Point, b: Point) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let length = dx * dx + dy * dy;
    let t = if length > 0.0 {
        ((p.x - a.x) * dx + (p.y - a.y) * dy) / length
    } else {
        0.0
    }
    .clamp(0.0, 1.0);
    (p.x - a.x - t * dx).hypot(p.y - a.y - t * dy)
}
fn cross(a: Point, b: Point, c: Point) -> f64 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}
fn contains(ring: &[Point], p: Point) -> bool {
    let mut inside = false;
    for (i, a) in ring.iter().enumerate() {
        let b = ring[(i + 1) % ring.len()];
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside = !inside;
        }
    }
    inside
}
fn area(ring: &[Point]) -> f64 {
    ring.iter()
        .enumerate()
        .map(|(i, a)| {
            let b = ring[(i + 1) % ring.len()];
            a.x * b.y - b.x * a.y
        })
        .sum::<f64>()
        .abs()
        / 2.0
}
fn intersects(a: Point, b: Point, c: Point, d: Point) -> bool {
    cross(a, b, c) * cross(a, b, d) < -EPS && cross(c, d, a) * cross(c, d, b) < -EPS
}
impl SpawnZone {
    pub fn boundary(&self) -> Vec<Point> {
        self.polygon.as_ref().map_or_else(
            || {
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
            },
            |polygon| polygon.boundary.clone(),
        )
    }
    fn rings(&self) -> Vec<Vec<Point>> {
        let mut rings = vec![self.boundary()];
        if let Some(polygon) = &self.polygon {
            rings.extend(polygon.holes.iter().cloned());
        }
        rings
    }
    pub fn contains_point(&self, p: Point) -> bool {
        contains(&self.boundary(), p)
            && !self
                .polygon
                .as_ref()
                .is_some_and(|polygon| polygon.holes.iter().any(|hole| contains(hole, p)))
    }
    /// The complete occupant disc stays in its region, including around holes.
    pub fn contains_disc(&self, p: Point, radius: f64) -> bool {
        self.contains_point(p)
            && self.rings().iter().all(|ring| {
                ring.iter().enumerate().all(|(i, a)| {
                    segment_distance(p, *a, ring[(i + 1) % ring.len()]) >= radius - EPS
                })
            })
    }
    pub(super) fn crosses_wall(&self, a: Point, b: Point) -> bool {
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let rings = self.rings();
        let mut cuts = vec![0.0, 1.0];
        for ring in &rings {
            for (i, c) in ring.iter().enumerate() {
                let d = ring[(i + 1) % ring.len()];
                let ex = d.x - c.x;
                let ey = d.y - c.y;
                let denom = dx * ey - dy * ex;
                if denom.abs() < EPS {
                    continue;
                }
                let t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / denom;
                let u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / denom;
                if t > 0.0 && t < 1.0 && (-EPS..=1.0 + EPS).contains(&u) {
                    cuts.push(t);
                }
            }
        }
        cuts.sort_by(f64::total_cmp);
        cuts.windows(2).any(|pair| {
            let t = (pair[0] + pair[1]) / 2.0;
            let p = Point {
                x: a.x + dx * t,
                y: a.y + dy * t,
            };
            self.contains_point(p)
                && rings.iter().all(|ring| {
                    ring.iter()
                        .enumerate()
                        .all(|(i, c)| segment_distance(p, *c, ring[(i + 1) % ring.len()]) > EPS)
                })
        })
    }
    pub(super) fn validate_shape(&self, scenario: &BuildingScenario) -> Result<(), String> {
        let rings = self.rings();
        if rings.iter().map(Vec::len).sum::<usize>() > 4000 {
            return Err("spawn polygons support at most 4000 total vertices".into());
        }
        for ring in &rings {
            if ring.len() < 3
                || ring.len() > 2000
                || area(ring) <= EPS
                || ring.iter().any(|p| {
                    !p.x.is_finite()
                        || !p.y.is_finite()
                        || p.x < self.x - EPS
                        || p.x > self.x + self.width + EPS
                        || p.y < self.y - EPS
                        || p.y > self.y + self.height + EPS
                })
            {
                return Err(
                    "spawn polygons need finite, in-bounds boundaries with at least three points"
                        .into(),
                );
            }
            for (i, a) in ring.iter().enumerate() {
                let b = ring[(i + 1) % ring.len()];
                if (a.x - b.x).hypot(a.y - b.y) <= EPS {
                    return Err("spawn polygon edges must have positive length".into());
                }
                for (j, c) in ring.iter().enumerate().skip(i + 1) {
                    if j == (i + 1) % ring.len() || (j + 1) % ring.len() == i {
                        continue;
                    }
                    if intersects(*a, b, *c, ring[(j + 1) % ring.len()]) {
                        return Err("spawn polygon boundaries must not self-intersect".into());
                    }
                }
            }
        }
        if rings
            .iter()
            .skip(1)
            .any(|hole| hole.iter().any(|p| !contains(&rings[0], *p)))
        {
            return Err("spawn polygon holes must lie inside their boundary".into());
        }
        let usable = area(&rings[0]) - rings.iter().skip(1).map(|ring| area(ring)).sum::<f64>();
        if f64::from(self.count) * std::f64::consts::PI * scenario.agent_radius.powi(2) > usable {
            return Err("spawn zones need sufficient polygon area for occupant discs".into());
        }
        if scenario
            .walls
            .iter()
            .any(|wall| self.crosses_wall(wall.start, wall.end))
        {
            return Err("spawn zones must not pass through walls".into());
        }
        Ok(())
    }
    pub(super) fn overlaps(&self, other: &Self) -> bool {
        if self.x >= other.x + other.width
            || other.x >= self.x + self.width
            || self.y >= other.y + other.height
            || other.y >= self.y + self.height
        {
            return false;
        }
        let a = self.boundary();
        let b = other.boundary();
        let inside = |zone: &Self, p| zone.contains_disc(p, EPS * 2.0);
        a.iter().any(|p| inside(other, *p))
            || b.iter().any(|p| inside(self, *p))
            || a.iter().enumerate().any(|(i, p)| {
                b.iter()
                    .enumerate()
                    .any(|(j, q)| intersects(*p, a[(i + 1) % a.len()], *q, b[(j + 1) % b.len()]))
            })
            || [self, other].iter().any(|zone| {
                let ring = zone.boundary();
                ring.iter().enumerate().any(|(i, p)| {
                    let q = ring[(i + 1) % ring.len()];
                    let length = (p.x - q.x).hypot(p.y - q.y);
                    [-1.0, 1.0].iter().any(|sign| {
                        let sample = Point {
                            x: (p.x + q.x) / 2.0 + sign * (q.y - p.y) / length * 1e-5,
                            y: (p.y + q.y) / 2.0 - sign * (q.x - p.x) / length * 1e-5,
                        };
                        inside(self, sample) && inside(other, sample)
                    })
                })
            })
    }
}
