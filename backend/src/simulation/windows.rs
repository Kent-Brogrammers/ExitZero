//! Conservative single-ground-floor window service. This is an exploratory
//! timing/capability model, not a prediction of real-world escape or injury.
use super::{
    Emergency,
    agent::Agent,
    geometry::Geometry,
    math,
    navigation::{Navigation, Route},
};
use crate::models::{BuildingScenario, Point, WindowFrameState, WindowPreparation, WindowState};
use std::collections::BTreeSet;

fn queue_point(s: &Station<'_>, rank: usize, radius: f64) -> Point {
    let distance = math::distance_to_point(s.approach, s.landing);
    let spacing = (2.0 * radius + 0.05) * rank as f64;
    Point {
        x: s.approach.x + (s.approach.x - s.landing.x) / distance * spacing,
        y: s.approach.y + (s.approach.y - s.landing.y) / distance * spacing,
    }
}

struct Station<'a> {
    index: usize,
    approach: Point,
    landing: Point,
    geometry: Geometry<'a>,
    navigation: Option<Navigation>,
    eligible: bool,
    snapshot: WindowFrameState,
    queue: Vec<usize>,
    traverser: Option<usize>,
}
struct Approach {
    station: usize,
    route: Route,
    cursor: usize,
}
pub(super) struct Windows<'a> {
    scenario: &'a BuildingScenario,
    stations: Vec<Station<'a>>,
    approaches: Vec<Option<Approach>>,
}

impl<'a> Windows<'a> {
    pub(super) fn new(
        scenario: &'a BuildingScenario,
        emergencies: &'a [Emergency],
        blocked: BTreeSet<String>,
        population: usize,
        geometry: &Geometry<'_>,
    ) -> Self {
        let mut stations = Vec::new();
        for (index, pane) in scenario.windows.iter().enumerate() {
            let wall = scenario
                .walls
                .iter()
                .find(|w| w.id == pane.wall_id)
                .unwrap();
            let normal = Point {
                x: -(wall.end.y - wall.start.y) / wall.length(),
                y: (wall.end.x - wall.start.x) / wall.length(),
            };
            let center = math::interpolate(
                wall.start,
                wall.end,
                (pane.offset + pane.width / 2.0) / wall.length(),
            );
            let side = f64::from(
                pane.emergency_escape
                    .as_ref()
                    .map_or(1, |e| e.exterior_side),
            );
            let clearance = scenario.agent_radius + wall.thickness / 2.0 + 1e-4;
            let approach = Point {
                x: center.x - side * clearance * normal.x,
                y: center.y - side * clearance * normal.y,
            };
            let landing = Point {
                x: center.x + side * clearance * normal.x,
                y: center.y + side * clearance * normal.y,
            };
            let crossing = if pane.emergency_escape.is_some() {
                Geometry::with_window_aperture(scenario, emergencies, blocked.clone(), pane)
            } else {
                Geometry::with_blocked_openings(scenario, emergencies, blocked.clone())
            };
            let in_workspace = |p: Point| {
                p.x >= scenario.agent_radius
                    && p.y >= scenario.agent_radius
                    && p.x <= scenario.width - scenario.agent_radius
                    && p.y <= scenario.height - scenario.agent_radius
            };
            let eligible = pane.emergency_escape.as_ref().is_some_and(|e| {
                e.enabled
                    && e.exterior_available
                    && e.clear_width_metres >= 2.0 * scenario.agent_radius
                    && scenario.window_escape_context.as_ref().is_some_and(|c| {
                        c.floor_elevation_metres == 0.0
                            && c.all_agents_can_traverse
                            && e.clear_height_metres >= c.required_clear_height_metres
                    })
                    && in_workspace(approach)
                    && in_workspace(landing)
                    && geometry.can_stand_at(approach)
                    && crossing.can_move(approach, landing)
            });
            stations.push(Station {
                index,
                approach,
                landing,
                geometry: crossing,
                navigation: eligible
                    .then(|| Navigation::to_point(scenario, geometry, pane.id.clone(), approach)),
                eligible,
                snapshot: WindowFrameState {
                    window_id: pane.id.clone(),
                    state: WindowState::Intact,
                    preparation_ready_step: None,
                    queue_agent_ids: vec![],
                    traversing_agent_id: None,
                    traversal_earliest_finish_step: None,
                },
                queue: vec![],
                traverser: None,
            });
        }
        Self {
            scenario,
            stations,
            approaches: (0..population).map(|_| None).collect(),
        }
    }

    pub(super) fn snapshots(&self, agents: &[Agent]) -> Option<Vec<WindowFrameState>> {
        (!self.stations.is_empty()).then(|| {
            self.stations
                .iter()
                .map(|s| {
                    let mut snapshot = s.snapshot.clone();
                    snapshot.queue_agent_ids = s.queue.iter().map(|&i| agents[i].id).collect();
                    snapshot.traversing_agent_id = s.traverser.map(|i| agents[i].id);
                    snapshot
                })
                .collect()
        })
    }
    pub(super) fn controls(&self, i: usize) -> bool {
        self.approaches[i].is_some()
    }
    pub(super) fn traversing(&self, i: usize) -> bool {
        self.stations.iter().any(|s| s.traverser == Some(i))
    }
    pub(super) fn has_priority(&self, i: usize) -> bool {
        self.stations
            .iter()
            .any(|s| s.traverser.is_none() && s.queue.first() == Some(&i))
    }
    pub(super) fn geometry<'b>(&'b self, i: usize, ordinary: &'b Geometry<'a>) -> &'b Geometry<'a> {
        self.stations
            .iter()
            .find(|s| s.traverser == Some(i))
            .map_or(ordinary, |s| &s.geometry)
    }
    pub(super) fn has_work(&self) -> bool {
        self.approaches.iter().any(Option::is_some)
            || self.stations.iter().any(|s| {
                matches!(
                    s.snapshot.state,
                    WindowState::Opening | WindowState::Breaking
                )
            })
    }
    pub(super) fn has_eligible(&self) -> bool {
        self.stations.iter().any(|s| s.eligible)
    }
    pub(super) fn refresh(
        &mut self,
        emergencies: &'a [Emergency],
        blocked: BTreeSet<String>,
        geometry: &Geometry<'_>,
    ) {
        let fresh = Self::new(
            self.scenario,
            emergencies,
            blocked,
            self.approaches.len(),
            geometry,
        );
        for (station, new) in self.stations.iter_mut().zip(fresh.stations) {
            station.geometry = new.geometry;
            station.navigation = new.navigation;
            station.eligible = new.eligible;
        }
        // Replan approach routes after physical opening events. Active service
        // and FIFO membership keep their stable window/agent references.
        for i in 0..self.approaches.len() {
            if !self.traversing(i) && !self.stations.iter().any(|s| s.queue.contains(&i)) {
                self.approaches[i] = None;
            }
        }
    }

    pub(super) fn update(
        &mut self,
        step: u32,
        agents: &[Agent],
        evacuated: &[bool],
        fallback: bool,
        geometry: &Geometry<'_>,
    ) {
        for s in &mut self.stations {
            if s.snapshot
                .preparation_ready_step
                .is_some_and(|ready| step >= ready)
            {
                s.snapshot.state = match s.snapshot.state {
                    WindowState::Opening => WindowState::Open,
                    WindowState::Breaking => WindowState::Broken,
                    other => other,
                };
            }
        }
        // A reopened normal exit wins before traversal begins. An active crossing
        // finishes on its current side-to-side path; it is never teleported back.
        for i in 0..agents.len() {
            if !fallback && !self.traversing(i) {
                self.approaches[i] = None;
            }
        }
        for s in &mut self.stations {
            s.queue
                .retain(|&i| !evacuated[i] && self.approaches[i].is_some());
        }
        if fallback {
            for i in 0..agents.len() {
                if evacuated[i] || self.controls(i) {
                    continue;
                }
                let mut best: Option<(f64, usize, Route)> = None;
                for (station, s) in self.stations.iter().enumerate().filter(|(_, s)| s.eligible) {
                    if let Some(route) = s
                        .navigation
                        .as_ref()
                        .unwrap()
                        .find_route(agents[i].position, geometry)
                    {
                        let mut from = agents[i].position;
                        let length: f64 = route
                            .waypoints
                            .iter()
                            .map(|&p| {
                                let d = math::distance_to_point(from, p);
                                from = p;
                                d
                            })
                            .sum();
                        if best
                            .as_ref()
                            .is_none_or(|(distance, _, _)| length < *distance)
                        {
                            best = Some((length, station, route));
                        }
                    }
                }
                if let Some((_, station, route)) = best {
                    self.approaches[i] = Some(Approach {
                        station,
                        route,
                        cursor: 0,
                    });
                }
            }
        }
        // Stable agent order breaks ties for arrivals on the same tick; existing
        // queue members retain FIFO priority. Disc collisions enforce spacing.
        let mut arrivals: Vec<_> = (0..agents.len())
            .filter(|&i| self.controls(i) && !self.traversing(i))
            .collect();
        arrivals.sort_by_key(|&i| agents[i].id);
        for i in arrivals {
            let a = self.approaches[i].as_mut().unwrap();
            for future in (a.cursor + 1..a.route.waypoints.len()).rev() {
                if geometry.can_move(agents[i].position, a.route.waypoints[future]) {
                    a.cursor = future;
                    break;
                }
            }
            if math::distance_to_point(agents[i].position, a.route.waypoints[a.cursor]) <= 1e-6
                && a.cursor + 1 < a.route.waypoints.len()
            {
                a.cursor += 1;
            }
            let s = &mut self.stations[a.station];
            let arrival = queue_point(
                s,
                s.queue.len() + usize::from(s.traverser.is_some()),
                self.scenario.agent_radius,
            );
            if a.cursor + 1 == a.route.waypoints.len()
                && math::distance_to_point(agents[i].position, arrival)
                    <= 2.0 * self.scenario.agent_radius + 0.15
                && !s.queue.contains(&i)
            {
                s.queue.push(i);
            }
        }
        for s in &mut self.stations {
            if s.traverser.is_some() {
                continue;
            }
            let Some(&head) = s.queue.first() else {
                continue;
            };
            if math::distance_to_point(agents[head].position, s.approach) > 1e-6 {
                continue;
            }
            let escape = self.scenario.windows[s.index]
                .emergency_escape
                .as_ref()
                .unwrap();
            if s.snapshot.state == WindowState::Intact {
                let ticks =
                    (escape.preparation_seconds / self.scenario.time_step_seconds).ceil() as u32;
                s.snapshot.preparation_ready_step = Some(step.saturating_add(ticks));
                s.snapshot.state = match (escape.preparation, ticks == 0) {
                    (WindowPreparation::Open, false) => WindowState::Opening,
                    (WindowPreparation::Break, false) => WindowState::Breaking,
                    (WindowPreparation::Open, true) => WindowState::Open,
                    (WindowPreparation::Break, true) => WindowState::Broken,
                };
            }
            if matches!(s.snapshot.state, WindowState::Open | WindowState::Broken) {
                s.traverser = Some(head);
                s.queue.remove(0);
                let ticks = (escape.traversal_seconds / self.scenario.time_step_seconds)
                    .ceil()
                    .max(1.0) as u32;
                s.snapshot.traversal_earliest_finish_step = Some(step.saturating_add(ticks));
            }
        }
    }

    pub(super) fn target(
        &self,
        i: usize,
        position: Point,
        geometry: &Geometry<'_>,
    ) -> Option<Point> {
        let a = self.approaches[i].as_ref()?;
        let s = &self.stations[a.station];
        if s.traverser == Some(i) {
            return Some(s.landing);
        }
        let rank = s
            .queue
            .iter()
            .position(|&j| j == i)
            .unwrap_or(s.queue.len())
            + usize::from(s.traverser.is_some());
        if rank > 0 && a.cursor + 1 == a.route.waypoints.len() {
            let target = queue_point(s, rank, self.scenario.agent_radius);
            return (math::distance_to_point(position, target) > 1e-6
                && geometry.can_move(position, target))
            .then_some(target);
        }
        let target = a.route.waypoints[a.cursor];
        (math::distance_to_point(position, target) > 1e-6).then_some(target)
    }
    pub(super) fn approach_limits(
        &self,
        i: usize,
        position: Point,
        dt: f64,
    ) -> Vec<super::motion::VelocityLimit> {
        let Some(a) = &self.approaches[i] else {
            return vec![];
        };
        let s = &self.stations[a.station];
        if s.traverser == Some(i)
            || s.traverser.is_none() && (s.queue.is_empty() || s.queue.first() == Some(&i))
        {
            return vec![];
        }
        let length = math::distance_to_point(s.approach, s.landing);
        let normal = Point {
            x: (s.approach.x - s.landing.x) / length,
            y: (s.approach.y - s.landing.y) / length,
        };
        let distance =
            (position.x - s.approach.x) * normal.x + (position.y - s.approach.y) * normal.y;
        vec![super::motion::VelocityLimit {
            normal,
            offset: ((2.0 * self.scenario.agent_radius + 0.01 - distance) / dt)
                .min(super::motion::WALKING_SPEED),
        }]
    }
    pub(super) fn movement_budget(&self, i: usize, normal_budget: f64) -> f64 {
        let Some(s) = self.stations.iter().find(|s| s.traverser == Some(i)) else {
            return normal_budget;
        };
        let escape = self.scenario.windows[s.index]
            .emergency_escape
            .as_ref()
            .unwrap();
        normal_budget.min(
            math::distance_to_point(s.approach, s.landing) / escape.traversal_seconds
                * self.scenario.time_step_seconds,
        )
    }
    pub(super) fn finish(&mut self, step: u32, agents: &[Agent]) -> Vec<(usize, String)> {
        let mut leaving = Vec::new();
        for s in &mut self.stations {
            if let Some(i) = s.traverser {
                if s.snapshot
                    .traversal_earliest_finish_step
                    .is_some_and(|ready| step >= ready)
                    && math::distance_to_point(agents[i].position, s.landing) <= 1e-6
                {
                    leaving.push((i, s.snapshot.window_id.clone()));
                    self.approaches[i] = None;
                    s.traverser = None;
                    s.snapshot.traversal_earliest_finish_step = None;
                }
            }
        }
        leaving
    }
}
