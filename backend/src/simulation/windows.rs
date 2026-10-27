//! Conservative single-ground-floor window service. This is an exploratory
//! timing/capability model, not a prediction of real-world escape or injury.
use super::{
    Emergency,
    agent::Agent,
    geometry::Geometry,
    math,
    navigation::{self, Navigation, Route},
};
use crate::models::{BuildingScenario, Point, WindowFrameState, WindowPreparation, WindowState};
use std::collections::BTreeSet;

// Disaster footprints are soft routing costs for ordinary walking. Starting a
// window crossing needs a clear landing and service lane, including that buffer.
fn safe_crossing(scenario: &BuildingScenario, geometry: &Geometry<'_>, a: Point, b: Point) -> bool {
    geometry.can_move(a, b)
        && geometry.disaster.is_none_or(|disaster| {
            geometry.hazard_areas.iter().all(|area| {
                let mut footprint = disaster;
                footprint.radius = area.radius;
                math::distance_to_segment(area.center, a, b)
                    > footprint.exposure_radius() + scenario.agent_radius
            })
        })
}

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
    navigation: Option<Navigation>,
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
            let mut crossing = if pane.emergency_escape.is_some() {
                Geometry::with_window_aperture(scenario, emergencies, blocked.clone(), pane)
            } else {
                Geometry::with_blocked_openings(scenario, emergencies, blocked.clone())
            };
            crossing.hazard_areas = geometry.hazard_areas.clone();
            let in_workspace = |p: Point| {
                p.x >= scenario.agent_radius
                    && p.y >= scenario.agent_radius
                    && p.x <= scenario.width - scenario.agent_radius
                    && p.y <= scenario.height - scenario.agent_radius
            };
            let unavailable_reason = (|| {
                if scenario
                    .disaster
                    .is_some_and(|d| d.kind == crate::models::DisasterKind::Tornado)
                {
                    return Some("Tornado response uses shelter zones.");
                }
                let Some(escape) = pane.emergency_escape.as_ref().filter(|e| e.enabled) else {
                    return Some(
                        "Last-resort escape is disabled. Enable it in this window's Properties.",
                    );
                };
                let Some(context) = &scenario.window_escape_context else {
                    return Some(
                        "Ground-floor traversal is not configured. Set the ground-floor assumption in window Properties.",
                    );
                };
                if context.floor_elevation_metres != 0.0 {
                    return Some("Window escape supports ground-floor layouts only.");
                }
                if !context.all_agents_can_traverse {
                    return Some("Occupant traversal capability is disabled in window Properties.");
                }
                if !escape.exterior_available {
                    return Some("Exterior landing availability is disabled in window Properties.");
                }
                if escape.clear_width_metres < 2.0 * scenario.agent_radius {
                    return Some("Usable window width is smaller than an occupant's diameter.");
                }
                if escape.clear_height_metres < context.required_clear_height_metres {
                    return Some("Usable window height is below the configured required height.");
                }
                if !in_workspace(approach) {
                    return Some(
                        "The indoor approach does not fit in the workspace. Check the exterior side and leave drawing space around the wall.",
                    );
                }
                if !in_workspace(landing) {
                    return Some(
                        "The exterior landing does not fit in the workspace. Leave drawing space outside the wall.",
                    );
                }
                if !geometry.can_stand_at(approach) {
                    return Some(
                        "The indoor approach is blocked. Check furniture, walls, and the configured exterior side.",
                    );
                }
                if !crossing.can_move(approach, landing) {
                    return Some(
                        "The window crossing is blocked. Check usable width, adjacent walls, and the exterior landing.",
                    );
                }
                if !safe_crossing(scenario, &crossing, approach, landing) {
                    return Some("Fire or gas covers the window crossing or exterior landing.");
                }
                None
            })();
            let eligible = unavailable_reason.is_none();
            stations.push(Station {
                index,
                approach,
                landing,
                geometry: crossing,
                navigation: None,
                eligible,
                snapshot: WindowFrameState {
                    window_id: pane.id.clone(),
                    state: WindowState::Intact,
                    preparation_ready_step: None,
                    queue_agent_ids: vec![],
                    traversing_agent_id: None,
                    traversal_earliest_finish_step: None,
                    unavailable_reason: unavailable_reason.map(str::to_owned),
                    approaching_agent_ids: Some(vec![]),
                },
                queue: vec![],
                traverser: None,
            });
        }
        Self {
            scenario,
            stations,
            approaches: (0..population).map(|_| None).collect(),
            navigation: None,
        }
    }

    pub(super) fn snapshots(&self, agents: &[Agent]) -> Option<Vec<WindowFrameState>> {
        (!self.stations.is_empty()).then(|| {
            self.stations
                .iter()
                .enumerate()
                .map(|(station, s)| {
                    let mut snapshot = s.snapshot.clone();
                    snapshot.queue_agent_ids = s.queue.iter().map(|&i| agents[i].id).collect();
                    snapshot.traversing_agent_id = s.traverser.map(|i| agents[i].id);
                    snapshot.approaching_agent_ids = Some(
                        self.approaches
                            .iter()
                            .enumerate()
                            .filter(|(i, a)| {
                                a.as_ref().is_some_and(|a| a.station == station)
                                    && !s.queue.contains(i)
                                    && s.traverser != Some(*i)
                            })
                            .map(|(i, _)| agents[i].id)
                            .collect(),
                    );
                    snapshot
                })
                .collect()
        })
    }
    pub(super) fn controls(&self, i: usize) -> bool {
        self.approaches[i].is_some()
    }
    /// Pursuit can catch a survivor in a service queue or during traversal.
    /// Release their slot without resetting preparation shared by other agents.
    pub(super) fn cancel(&mut self, i: usize) {
        self.approaches[i] = None;
        for station in &mut self.stations {
            station.queue.retain(|&member| member != i);
            if station.traverser == Some(i) {
                station.traverser = None;
                station.snapshot.traversal_earliest_finish_step = None;
            }
        }
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
    pub(super) fn has_timed_service(&self, step: u32) -> bool {
        self.stations.iter().any(|station| {
            (station.eligible
                && !station.queue.is_empty()
                && matches!(
                    station.snapshot.state,
                    WindowState::Opening | WindowState::Breaking
                )
                && station
                    .snapshot
                    .preparation_ready_step
                    .is_some_and(|ready| ready > step))
                || (station.traverser.is_some()
                    && station
                        .snapshot
                        .traversal_earliest_finish_step
                        .is_some_and(|ready| ready > step))
        })
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
            station.snapshot.unavailable_reason = new.snapshot.unavailable_reason;
        }
        self.navigation = None;
        // Replan approach routes after physical opening events. Active service
        // and FIFO membership keep their stable window/agent references.
        for i in 0..self.approaches.len() {
            if !self.traversing(i)
                && self.approaches[i].as_ref().is_some_and(|a| {
                    !self.stations[a.station].eligible
                        || !self.stations[a.station].queue.contains(&i)
                })
            {
                self.approaches[i] = None;
            }
        }
    }

    pub(super) fn update(
        &mut self,
        step: u32,
        agents: &[Agent],
        evacuated: &[bool],
        fallback: &[bool],
        geometry: &Geometry<'_>,
    ) {
        let mut reachable = vec![false; self.stations.len()];
        for s in &mut self.stations {
            if s.eligible {
                s.snapshot.unavailable_reason = None;
            }
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
        for (i, &needs_window) in fallback.iter().enumerate() {
            if !needs_window && !self.traversing(i) {
                self.approaches[i] = None;
            }
        }
        for s in &mut self.stations {
            s.queue
                .retain(|&i| !evacuated[i] && self.approaches[i].is_some());
        }
        for approach in self.approaches.iter().flatten() {
            reachable[approach.station] = true;
        }
        // Window eligibility and service do not need route graphs. Construct
        // one shared topology only when somebody actually needs a fallback.
        // Preserve the existing physical-map policy for window approaches.
        if self.stations.iter().any(|s| s.eligible)
            && (0..agents.len()).any(|i| !evacuated[i] && fallback[i] && !self.controls(i))
        {
            let navigation = self
                .navigation
                .get_or_insert_with(|| Navigation::new(self.scenario, geometry));
            for s in self
                .stations
                .iter_mut()
                .filter(|s| s.eligible && s.navigation.is_none())
            {
                s.navigation = Some(
                    navigation
                        .with_point_target(self.scenario.windows[s.index].id.clone(), s.approach),
                );
            }
        }
        let mut attempted = false;
        for i in 0..agents.len() {
            if evacuated[i] || !fallback[i] || self.controls(i) {
                continue;
            }
            attempted = true;
            let mut best: Option<(f64, usize, Route)> = None;
            for (station, s) in self.stations.iter().enumerate().filter(|(_, s)| s.eligible) {
                if let Some(route) = s
                    .navigation
                    .as_ref()
                    .unwrap()
                    .find_route_avoiding_danger(agents[i].position, geometry)
                {
                    reachable[station] = true;
                    let cost = navigation::route_cost(
                        agents[i].position,
                        &route.waypoints,
                        &super::congestion::CrowdForecast::for_geometry(geometry),
                        self.scenario.agent_radius,
                    );
                    if best
                        .as_ref()
                        .is_none_or(|(distance, _, _)| cost < *distance)
                    {
                        best = Some((cost, station, route));
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
        for (station, s) in self.stations.iter_mut().enumerate() {
            if attempted && s.eligible && !reachable[station] {
                s.snapshot.unavailable_reason = Some("No route to the configured indoor approach. Check the exterior direction and intervening barriers.".into());
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
                if geometry.can_move(agents[i].position, a.route.waypoints[future])
                    && geometry.avoids_known_danger(agents[i].position, a.route.waypoints[future])
                {
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
            if s.traverser.is_some() || !s.eligible {
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
                && geometry.can_move(position, target)
                && geometry.avoids_known_danger(position, target))
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
            if let Some(i) = s.traverser
                && s.snapshot
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
        leaving
    }
}
