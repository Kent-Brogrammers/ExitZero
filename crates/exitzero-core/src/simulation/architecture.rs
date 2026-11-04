//! Architectural exterior knowledge, independent of opening states and hazards.
//! Split wall centre lines into a planar graph; bounded faces distinguish an
//! enclosing shell from interior partitions, including concave/angled layouts.
use super::{
    math,
    perception::{self, WallKnowledge, WallSpan},
};
use crate::models::{BuildingScenario, Point};
use std::collections::BTreeSet;

const EPS: f64 = 1e-6;

pub(super) struct Architecture {
    pub exterior: WallKnowledge,
    faces: Vec<Vec<Point>>,
}

fn cross(a: Point, b: Point) -> f64 {
    a.x * b.y - a.y * b.x
}
fn delta(a: Point, b: Point) -> Point {
    Point {
        x: a.x - b.x,
        y: a.y - b.y,
    }
}
fn vertex(points: &mut Vec<Point>, p: Point) -> usize {
    if let Some(i) = points
        .iter()
        .position(|&q| math::distance_to_point(p, q) <= EPS)
    {
        i
    } else {
        points.push(p);
        points.len() - 1
    }
}
fn root(parents: &mut [usize], i: usize) -> usize {
    if parents[i] != i {
        parents[i] = root(parents, parents[i]);
    }
    parents[i]
}

impl Architecture {
    pub(super) fn new(scenario: &BuildingScenario) -> Self {
        let walls = &scenario.walls;
        let mut cuts = vec![vec![0.0, 1.0]; walls.len()];
        let mut contacts = Vec::new();
        for (i, a) in walls.iter().enumerate() {
            if super::control::cancelled() {
                break;
            }
            for (j, b) in walls.iter().enumerate().skip(i + 1) {
                let u = delta(a.end, a.start);
                let v = delta(b.end, b.start);
                let determinant = cross(u, v);
                let mut joined = false;
                if determinant.abs() > 1e-10 {
                    let d = delta(b.start, a.start);
                    let t = cross(d, v) / determinant;
                    let s = cross(d, u) / determinant;
                    if (-EPS..=1.0 + EPS).contains(&t) && (-EPS..=1.0 + EPS).contains(&s) {
                        cuts[i].push(t.clamp(0.0, 1.0));
                        cuts[j].push(s.clamp(0.0, 1.0));
                        joined = true;
                    }
                } else {
                    for (source, target, index) in [(a, b, j), (b, a, i)] {
                        for p in [source.start, source.end] {
                            let q = math::closest_point_on_segment(p, target.start, target.end);
                            if math::distance_to_point(p, q) <= EPS {
                                cuts[index].push(
                                    math::distance_to_point(target.start, q) / target.length(),
                                );
                                joined = true;
                            }
                        }
                    }
                }
                // Match real material contacts in hand-drawn T joins; no snap radius.
                if !joined {
                    for (source, target, index) in [(a, b, j), (b, a, i)] {
                        for p in [source.start, source.end] {
                            let q = math::closest_point_on_segment(p, target.start, target.end);
                            if math::distance_to_point(p, q)
                                <= (source.thickness + target.thickness) / 2.0 + EPS
                            {
                                cuts[index].push(
                                    math::distance_to_point(target.start, q) / target.length(),
                                );
                                contacts.push((p, q));
                            }
                        }
                    }
                }
            }
        }
        let mut points = Vec::new();
        let mut edges = Vec::new();
        let mut sources = Vec::new();
        for (index, (wall, ts)) in walls.iter().zip(&mut cuts).enumerate() {
            ts.sort_by(f64::total_cmp);
            ts.dedup_by(|a, b| (*a - *b).abs() <= 1e-10);
            for pair in ts.windows(2) {
                let a = vertex(
                    &mut points,
                    math::interpolate(wall.start, wall.end, pair[0]),
                );
                let b = vertex(
                    &mut points,
                    math::interpolate(wall.start, wall.end, pair[1]),
                );
                if a != b {
                    edges.push((a, b));
                    sources.push((index, pair[0], pair[1], a, b));
                }
            }
        }
        let contacts: Vec<_> = contacts
            .into_iter()
            .map(|(a, b)| (vertex(&mut points, a), vertex(&mut points, b)))
            .collect();
        let mut parents: Vec<_> = (0..points.len()).collect();
        for (a, b) in contacts {
            let a = root(&mut parents, a);
            let b = root(&mut parents, b);
            if a != b {
                parents[b] = a;
            }
        }
        let mut neighbors = vec![BTreeSet::new(); points.len()];
        for (a, b) in edges {
            let a = root(&mut parents, a);
            let b = root(&mut parents, b);
            if a != b {
                neighbors[a].insert(b);
                neighbors[b].insert(a);
            }
        }
        let ordered: Vec<Vec<usize>> = neighbors
            .into_iter()
            .enumerate()
            .map(|(i, n)| {
                let mut n: Vec<_> = n.into_iter().collect();
                n.sort_by(|&a, &b| {
                    (points[a].y - points[i].y)
                        .atan2(points[a].x - points[i].x)
                        .total_cmp(&(points[b].y - points[i].y).atan2(points[b].x - points[i].x))
                });
                n
            })
            .collect();
        let mut visited = BTreeSet::new();
        let mut faces = Vec::new();
        for (from, neighbors) in ordered.iter().enumerate() {
            for &to in neighbors {
                if visited.contains(&(from, to)) {
                    continue;
                }
                let mut face = Vec::new();
                let (mut a, mut b) = (from, to);
                loop {
                    if !visited.insert((a, b)) {
                        break;
                    }
                    face.push(points[a]);
                    let around = &ordered[b];
                    let back = around.iter().position(|&v| v == a).unwrap();
                    let next = around[(back + around.len() - 1) % around.len()];
                    a = b;
                    b = next;
                    if (a, b) == (from, to) {
                        break;
                    }
                }
                let area: f64 = (0..face.len())
                    .map(|i| cross(face[i], face[(i + 1) % face.len()]))
                    .sum();
                if (a, b) == (from, to) && area > EPS {
                    faces.push(face);
                }
            }
        }
        let mut result = Self {
            exterior: WallKnowledge::new(),
            faces,
        };
        let mut exterior = WallKnowledge::new();
        for (index, start, end, a, b) in sources {
            let wall = &walls[index];
            let a = points[root(&mut parents, a)];
            let b = points[root(&mut parents, b)];
            let length = math::distance_to_point(a, b);
            if length <= EPS {
                continue;
            }
            let n = Point {
                x: -(b.y - a.y) / length,
                y: (b.x - a.x) / length,
            };
            let p = math::interpolate(a, b, 0.5);
            let left = result.contains(Point {
                x: p.x + n.x * 1e-5,
                y: p.y + n.y * 1e-5,
            });
            let right = result.contains(Point {
                x: p.x - n.x * 1e-5,
                y: p.y - n.y * 1e-5,
            });
            if left != right {
                exterior.entry(wall.id.clone()).or_default().push(WallSpan {
                    start: start * wall.length(),
                    end: end * wall.length(),
                });
            }
        }
        perception::remember(&mut result.exterior, &exterior);
        result
    }

    pub(super) fn contains(&self, p: Point) -> bool {
        self.faces
            .iter()
            .any(|face| math::point_in_polygon(p, face))
    }

    /// An open sketch supplies no enclosed footprint. Do not turn workspace
    /// extents into an invented building boundary or strand outdoor spawns.
    pub(super) fn allows_exploration(&self, from: Point, waypoints: &[Point]) -> bool {
        if !self.contains(from) {
            return true;
        }
        let mut a = from;
        for &b in waypoints {
            if !self.contains(b) {
                return false;
            }
            let direction = delta(b, a);
            let mut cuts = vec![0.0, 1.0];
            for face in &self.faces {
                for i in 0..face.len() {
                    let c = face[i];
                    let d = face[(i + 1) % face.len()];
                    let edge = delta(d, c);
                    let determinant = cross(direction, edge);
                    if determinant.abs() <= 1e-12 {
                        continue;
                    }
                    let offset = delta(c, a);
                    let t = cross(offset, edge) / determinant;
                    let s = cross(offset, direction) / determinant;
                    if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&s) {
                        cuts.push(t);
                    }
                }
            }
            cuts.sort_by(f64::total_cmp);
            if cuts
                .windows(2)
                .any(|p| !self.contains(math::interpolate(a, b, (p[0] + p[1]) * 0.5)))
            {
                return false;
            }
            a = b;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Wall;

    fn building() -> BuildingScenario {
        let mut b: BuildingScenario = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../shared/examples/building.json"
        )))
        .unwrap();
        b.walls.clear();
        b.doors.clear();
        b.exits.clear();
        b.obstructions.clear();
        b
    }
    fn wall(id: &str, a: (f64, f64), b: (f64, f64)) -> Wall {
        Wall {
            id: id.into(),
            name: None,
            start: Point { x: a.0, y: a.1 },
            end: Point { x: b.0, y: b.1 },
            thickness: 0.2,
        }
    }
    fn ring(b: &mut BuildingScenario, name: &str, p: &[(f64, f64)]) {
        for i in 0..p.len() {
            b.walls
                .push(wall(&format!("{name}-{i}"), p[i], p[(i + 1) % p.len()]));
        }
    }

    #[test]
    fn only_the_exterior_is_known_with_partitions_nested_rooms_and_dangling_walls() {
        let mut b = building();
        ring(
            &mut b,
            "outer",
            &[(2.0, 2.0), (18.0, 2.0), (18.0, 18.0), (2.0, 18.0)],
        );
        b.walls.push(wall("partition", (10.0, 2.0), (10.0, 18.0)));
        ring(
            &mut b,
            "inner",
            &[(4.0, 4.0), (8.0, 4.0), (8.0, 8.0), (4.0, 8.0)],
        );
        b.walls.push(wall("dangling", (12.0, 10.0), (16.0, 10.0)));
        let layout = Architecture::new(&b);
        assert_eq!(layout.exterior.len(), 4);
        assert!(layout.exterior.keys().all(|id| id.starts_with("outer")));
        assert!(layout.exterior.values().all(|spans| spans
            == &vec![WallSpan {
                start: 0.0,
                end: 16.0
            }]));
        assert!(layout.allows_exploration(Point { x: 5.0, y: 5.0 }, &[Point { x: 15.0, y: 5.0 }]));
        assert!(!layout.allows_exploration(Point { x: 5.0, y: 5.0 }, &[Point { x: 1.0, y: 5.0 }]));
    }

    #[test]
    fn concave_and_angled_shells_do_not_become_bounding_boxes() {
        let mut b = building();
        ring(
            &mut b,
            "outer",
            &[
                (2.0, 2.0),
                (18.0, 2.0),
                (18.0, 8.0),
                (8.0, 8.0),
                (8.0, 18.0),
                (2.0, 18.0),
            ],
        );
        let shape = Architecture::new(&b);
        assert_eq!(shape.exterior.len(), 6);
        assert!(!shape.contains(Point { x: 15.0, y: 15.0 }));
        assert!(!shape.allows_exploration(Point { x: 16.0, y: 6.0 }, &[Point { x: 6.0, y: 16.0 }]));
        assert!(shape.allows_exploration(
            Point { x: 16.0, y: 6.0 },
            &[Point { x: 6.0, y: 6.0 }, Point { x: 6.0, y: 16.0 }]
        ));
        let mut angled = building();
        ring(
            &mut angled,
            "diamond",
            &[(10.0, 2.0), (18.0, 10.0), (10.0, 18.0), (2.0, 10.0)],
        );
        angled
            .walls
            .push(wall("partition", (6.0, 6.0), (14.0, 14.0)));
        assert_eq!(Architecture::new(&angled).exterior.len(), 4);
    }

    #[test]
    fn a_wall_that_is_only_partly_exterior_does_not_reveal_its_internal_extension() {
        let mut b = building();
        ring(
            &mut b,
            "outer",
            &[
                (2.0, 2.0),
                (18.0, 2.0),
                (18.0, 8.0),
                (8.0, 8.0),
                (8.0, 18.0),
                (2.0, 18.0),
            ],
        );
        b.walls[3] = wall("mixed", (8.0, 2.0), (8.0, 18.0));
        let shape = Architecture::new(&b);
        assert_eq!(
            shape.exterior["mixed"],
            vec![WallSpan {
                start: 6.0,
                end: 16.0
            }]
        );
    }

    #[test]
    fn thickness_contacts_close_real_shells_and_open_sketches_reveal_no_walls() {
        let mut b = building();
        ring(
            &mut b,
            "outer",
            &[(2.0, 2.0), (18.0, 2.0), (18.0, 18.0), (2.0, 18.0)],
        );
        b.walls[1].end.y = 17.95;
        assert_eq!(Architecture::new(&b).exterior.len(), 4);
        b.walls.truncate(2);
        let open = Architecture::new(&b);
        assert!(open.exterior.is_empty());
        assert!(open.allows_exploration(Point { x: 5.0, y: 5.0 }, &[Point { x: 1.0, y: 5.0 }]));
    }
}
