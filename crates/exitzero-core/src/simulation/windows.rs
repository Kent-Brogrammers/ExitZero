//! Conservative single-ground-floor window service. This is an exploratory
//! timing/capability model, not a prediction of real-world escape or injury.
use super::{
    Emergency,
    agent::Agent,
    geometry::Geometry,
    math,
    navigation::{self, Navigation, Route},
};
use crate::models::{
    AgentPlannedPath, BuildingScenario, Point, WindowFrameState, WindowPreparation, WindowState,
};
use std::collections::BTreeSet;

// Window crossings avoid burning cores and gas exposure footprints. Fire's
// outer ring remains traversable, with exposure still recorded during service.
fn safe_crossing(scenario: &BuildingScenario, geometry: &Geometry<'_>, a: Point, b: Point) -> bool {
    geometry.can_move(a, b)
        && geometry.disaster.is_none_or(|disaster| {
            geometry.hazard_areas.iter().all(|area| {
                let mut footprint = disaster;
                footprint.radius = area.radius;
                math::distance_to_segment(area.center, a, b)
                    > (if disaster.kind == crate::models::DisasterKind::Fire {
                        area.radius
                    } else {
                        footprint.exposure_radius()
                    }) + scenario.agent_radius
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
struct Search {
    route: Route,
    cursor: usize,
    since: u32,
}
pub(super) struct Windows<'a> {
    decisions: crate::models::WindowDecisionHistory,
    scenario: &'a BuildingScenario,
    stations: Vec<Station<'a>>,
    approaches: Vec<Option<Approach>>,
    searches: Vec<Option<Search>>,
    searched_steps: Vec<u32>,
    searched_views: Vec<Vec<Point>>,
    navigation: Option<Navigation>,
    known_windows: Vec<BTreeSet<usize>>,
    last_discovery_step: Option<u32>,
    last_search_step: Option<u32>,
    beliefs: super::awareness::BeliefMaps<'a>,
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
            decisions: crate::models::WindowDecisionHistory::default(),
            scenario,
            stations,
            approaches: (0..population).map(|_| None).collect(),
            searches: (0..population).map(|_| None).collect(),
            searched_steps: vec![0; population],
            searched_views: vec![vec![]; population],
            navigation: None,
            known_windows: vec![BTreeSet::new(); population],
            last_discovery_step: None,
            last_search_step: None,
            beliefs: super::awareness::BeliefMaps::new(scenario, emergencies),
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

    pub(super) fn take_decisions(&mut self) -> crate::models::WindowDecisionHistory {
        std::mem::take(&mut self.decisions)
    }
    pub(super) fn controls(&self, i: usize) -> bool {
        self.approaches[i].is_some() || self.searches[i].is_some()
    }
    pub(super) fn searching(&self, i: usize) -> bool {
        self.searches[i].is_some()
    }
    pub(super) fn using_window(&self, i: usize) -> bool {
        self.approaches[i].is_some()
    }
    /// Pursuit can catch a survivor in a service queue or during traversal.
    /// Release their slot without resetting preparation shared by other agents.
    pub(super) fn cancel(&mut self, i: usize) {
        self.approaches[i] = None;
        self.searches[i] = None;
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
        self.searches.iter().any(Option::is_some)
            || self.approaches.iter().any(Option::is_some)
            || self.stations.iter().any(|s| {
                matches!(
                    s.snapshot.state,
                    WindowState::Opening | WindowState::Breaking
                )
            })
    }
    /// Searching must not depend on the existence or actual state of hidden panes.
    pub(super) fn can_consider(&self) -> bool {
        self.scenario
            .window_escape_context
            .as_ref()
            .is_none_or(|c| c.floor_elevation_metres == 0.0 && c.all_agents_can_traverse)
            && self
                .scenario
                .disaster
                .is_none_or(|d| d.kind != crate::models::DisasterKind::Tornado)
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
        // Ordinary occupants replan only after learned information changes.
        // The separate pursuit mode deliberately uses a known house layout.
        if self.scenario.pursuit.is_some() {
            for i in 0..self.approaches.len() {
                if !self.traversing(i)
                    && self.approaches[i]
                        .as_ref()
                        .is_some_and(|a| !self.stations[a.station].queue.contains(&i))
                {
                    self.approaches[i] = None;
                }
            }
        }
    }

    fn prepare_navigation(&mut self, geometry: &Geometry<'_>) {
        let navigation = self
            .navigation
            .get_or_insert_with(|| Navigation::new(self.scenario, geometry));
        for s in self
            .stations
            .iter_mut()
            .filter(|s| s.eligible && s.navigation.is_none())
        {
            s.navigation = Some(
                navigation.with_point_target(self.scenario.windows[s.index].id.clone(), s.approach),
            );
        }
    }

    fn discover(&mut self, agents: &[Agent], evacuated: &[bool], geometry: &Geometry<'_>) {
        for (i, agent) in agents.iter().enumerate() {
            if evacuated[i] {
                continue;
            }
            for (station, pane) in self.scenario.windows.iter().enumerate() {
                if !self.known_windows[i].contains(&station)
                    && geometry.can_see_window(
                        agent.position,
                        pane,
                        self.scenario.awareness.visibility_range(),
                    )
                {
                    self.known_windows[i].insert(station);
                }
            }
        }
        // Match ordinary discovery reports: one hop per tick, through clear sight.
        if self.scenario.awareness.communication_range_metres <= 0.0 {
            return;
        }
        let snapshot = self.known_windows.clone();
        for i in 0..agents.len() {
            if evacuated[i] {
                continue;
            }
            for j in i + 1..agents.len() {
                if !evacuated[j]
                    && snapshot[i] != snapshot[j]
                    && super::awareness::can_communicate(
                        agents[i].position,
                        agents[j].position,
                        self.scenario.awareness.communication_range_metres,
                        geometry,
                    )
                {
                    self.known_windows[i].extend(&snapshot[j]);
                    self.known_windows[j].extend(&snapshot[i]);
                }
            }
        }
    }

    fn approach_route(
        &mut self,
        station: usize,
        agent: &Agent,
        geometry: &Geometry<'_>,
    ) -> Option<Route> {
        if self.scenario.pursuit.is_some() {
            return self.stations[station]
                .navigation
                .as_ref()
                .unwrap()
                .find_route_avoiding_danger(agent.position, geometry);
        }
        let architecture = self.beliefs.architecture.clone();
        let (map, navigation) = self.beliefs.for_agent(agent);
        let forecast = super::congestion::CrowdForecast::for_geometry(map).with_discovery(
            self.scenario,
            agent,
            map,
        );
        let route = navigation
            .with_point_target(
                self.scenario.windows[station].id.clone(),
                self.stations[station].approach,
            )
            .find_safe_route_with_forecast(
                agent.position,
                map,
                &forecast,
                self.scenario.agent_radius,
            )?;
        architecture
            .allows_exploration(agent.position, &route.waypoints)
            .then_some(route)
    }

    fn travel_seconds(&self, agent: &Agent, waypoints: &[Point]) -> f64 {
        let estimate = self.beliefs.cached_geometry(agent).map_or_else(
            super::congestion::CrowdForecast::default,
            |map| {
                super::congestion::CrowdForecast::default().with_discovery(
                    self.scenario,
                    agent,
                    map,
                )
            },
        );
        navigation::route_cost(
            agent.position,
            waypoints,
            &estimate,
            self.scenario.agent_radius,
        ) / (super::motion::WALKING_SPEED * (1.0 - 0.75 * agent.injury))
    }

    /// Predict serial service, including people still approaching this window.
    /// Reservations are made as agents choose, so later choices see earlier ones.
    fn escape_seconds(
        &self,
        station: usize,
        step: u32,
        i: usize,
        route: &Route,
        agents: &[Agent],
    ) -> f64 {
        let s = &self.stations[station];
        let escape = self.scenario.windows[s.index]
            .emergency_escape
            .as_ref()
            .unwrap();
        let dt = self.scenario.time_step_seconds;
        let traversal = |member: usize| {
            let speed = super::motion::WALKING_SPEED * (1.0 - 0.75 * agents[member].injury);
            ((escape.traversal_seconds / dt).ceil().max(1.0) * dt)
                .max(math::distance_to_point(s.approach, s.landing) / speed)
        };
        let mut arrivals: Vec<_> = self
            .approaches
            .iter()
            .enumerate()
            .filter_map(|(j, approach)| {
                let approach = approach.as_ref()?;
                if j == i || approach.station != station || s.traverser == Some(j) {
                    return None;
                }
                let rank = s.queue.iter().position(|&member| member == j);
                let eta = if rank.is_some() {
                    0.0
                } else {
                    self.travel_seconds(&agents[j], &approach.route.waypoints[approach.cursor..])
                };
                Some((eta, rank.unwrap_or(usize::MAX), j))
            })
            .collect();
        let rank = s.queue.iter().position(|&member| member == i);
        arrivals.push((
            if rank.is_some() {
                0.0
            } else {
                let remaining = self.approaches[i]
                    .as_ref()
                    .filter(|a| a.station == station)
                    .map_or(route.waypoints.as_slice(), |a| {
                        &a.route.waypoints[a.cursor..]
                    });
                self.travel_seconds(&agents[i], remaining)
            },
            rank.unwrap_or(usize::MAX),
            i,
        ));
        arrivals.sort_by(|a, b| {
            a.0.total_cmp(&b.0)
                .then_with(|| a.1.cmp(&b.1))
                .then_with(|| agents[a.2].id.cmp(&agents[b.2].id))
        });
        let mut available = match s.snapshot.state {
            WindowState::Intact => arrivals[0].0 + (escape.preparation_seconds / dt).ceil() * dt,
            WindowState::Opening | WindowState::Breaking => {
                f64::from(
                    s.snapshot
                        .preparation_ready_step
                        .unwrap()
                        .saturating_sub(step),
                ) * dt
            }
            _ => 0.0,
        };
        if let Some(member) = s.traverser {
            let speed = super::motion::WALKING_SPEED * (1.0 - 0.75 * agents[member].injury);
            let remaining = math::distance_to_point(agents[member].position, s.landing) / speed;
            available = available.max(
                remaining.max(
                    f64::from(
                        s.snapshot
                            .traversal_earliest_finish_step
                            .unwrap()
                            .saturating_sub(step),
                    ) * dt,
                ),
            );
        }
        for (arrival, _, member) in arrivals {
            available = available.max(arrival) + traversal(member);
            if member == i {
                return available;
            }
        }
        unreachable!("candidate is included in service estimate")
    }

    pub(super) fn update(
        &mut self,
        step: u32,
        agents: &[Agent],
        evacuated: &[bool],
        fallback: &[bool],
        geometry: &Geometry<'_>,
    ) {
        self.update_inner(step, agents, evacuated, fallback, geometry, None);
    }

    fn believed_usable(&mut self, station: usize, agent: &Agent, world: &Geometry<'_>) -> bool {
        let s = &self.stations[station];
        if self.scenario.pursuit.is_some() {
            return s.eligible;
        }
        let pane = &self.scenario.windows[station];
        let Some(escape) = pane.emergency_escape.as_ref().filter(|e| e.enabled) else {
            return false;
        };
        if !self.can_consider()
            || !escape.exterior_available
            || escape.clear_width_metres < 2.0 * self.scenario.agent_radius
            || self
                .scenario
                .window_escape_context
                .as_ref()
                .is_some_and(|c| escape.clear_height_metres < c.required_clear_height_metres)
        {
            return false;
        }
        let r = self.scenario.agent_radius;
        if [s.approach, s.landing].iter().any(|p| {
            p.x < r || p.y < r || p.x > self.scenario.width - r || p.y > self.scenario.height - r
        }) {
            return false;
        }
        // Physical service failure is learned locally, rather than cancelling
        // a distant person's approach when an unseen hazard changes the world.
        if !s.eligible
            && math::distance_to_point(agent.position, s.approach) <= 1.0
            && world.can_see_window(
                agent.position,
                pane,
                self.scenario.awareness.visibility_range(),
            )
        {
            return false;
        }
        let map = self.beliefs.geometry_for_agent(agent);
        map.can_stand_at(s.approach)
            && !map.is_in_known_danger(s.approach)
            && !map.is_in_known_danger(s.landing)
    }

    pub(super) fn choose(
        &mut self,
        step: u32,
        agents: &[Agent],
        evacuated: &[bool],
        exit_seconds: &[f64],
        geometry: &Geometry<'_>,
    ) {
        let fallback: Vec<_> = exit_seconds.iter().map(|s| !s.is_finite()).collect();
        self.update_inner(
            step,
            agents,
            evacuated,
            &fallback,
            geometry,
            Some(exit_seconds),
        );
        let new_tick = self.last_search_step != Some(step);
        self.last_search_step = Some(step);
        for (i, agent) in agents.iter().enumerate() {
            if evacuated[i] || self.approaches[i].is_some() || !self.can_consider() {
                self.searches[i] = None;
                continue;
            }
            if self.searches[i].is_some() && new_tick {
                self.searched_steps[i] += 1;
            }
            // A failed search consumes real simulated time. Never search
            // forever or use hidden window counts to decide when to give up.
            let budget = (12.0 / self.scenario.time_step_seconds).ceil() as u32;
            let prior_service = (8.0
                + 4.0 * super::discovery::sample(self.scenario.seed, agent.id, 4))
                / (1.0 - 0.75 * agent.injury);
            if self.searched_steps[i] >= budget || prior_service + 2.0 >= exit_seconds[i] * 0.85 {
                self.searches[i] = None;
                continue;
            }
            let map = self.beliefs.geometry_for_agent(agent);
            if let Some(search) = &mut self.searches[i] {
                while search.cursor + 1 < search.route.waypoints.len()
                    && math::distance_to_point(
                        agent.position,
                        search.route.waypoints[search.cursor],
                    ) < 0.25
                {
                    search.cursor += 1;
                }
                let arrived = math::distance_to_point(
                    agent.position,
                    *search.route.waypoints.last().unwrap(),
                ) < 0.3;
                let valid = map.can_move(agent.position, search.route.waypoints[search.cursor])
                    && map
                        .avoids_known_danger(agent.position, search.route.waypoints[search.cursor]);
                if !arrived
                    && valid
                    && f64::from(step.saturating_sub(search.since))
                        * self.scenario.time_step_seconds
                        < 3.0
                {
                    continue;
                }
                self.searched_views[i].push(*search.route.waypoints.last().unwrap());
                if self.searched_views[i].len() > 16 {
                    self.searched_views[i].remove(0);
                }
                self.searches[i] = None;
            }
            // Limit graph searches to twice per simulated second.
            let interval = (0.5 / self.scenario.time_step_seconds).ceil().max(1.0) as u32;
            if !step.is_multiple_of(interval) {
                continue;
            }
            let architecture = self.beliefs.architecture.clone();
            let (map, navigation) = self.beliefs.for_agent(agent);
            if let Some(route) = super::discovery::search_route(
                self.scenario,
                agent,
                map,
                navigation,
                &self.searched_views[i],
                &architecture,
            ) {
                let forecast = super::congestion::CrowdForecast::for_geometry(map).with_discovery(
                    self.scenario,
                    agent,
                    map,
                );
                let travel = navigation::route_cost(
                    agent.position,
                    &route.waypoints,
                    &forecast,
                    self.scenario.agent_radius,
                ) / (super::motion::WALKING_SPEED * (1.0 - 0.75 * agent.injury));
                if travel + prior_service < exit_seconds[i] * 0.85 {
                    self.searches[i] = Some(Search {
                        route,
                        cursor: 0,
                        since: step,
                    });
                }
            }
        }
    }

    fn update_inner(
        &mut self,
        step: u32,
        agents: &[Agent],
        evacuated: &[bool],
        fallback: &[bool],
        geometry: &Geometry<'_>,
        exit_seconds: Option<&[f64]>,
    ) {
        if self.stations.is_empty() {
            return;
        }
        if self.last_discovery_step != Some(step) {
            self.discover(agents, evacuated, geometry);
            self.last_discovery_step = Some(step);
        }
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
        // Keep a commitment until the normal route becomes materially faster.
        // An active crossing always finishes on its current side-to-side path.
        for (i, &needs_window) in fallback.iter().enumerate() {
            let keep = exit_seconds.map_or(needs_window, |seconds| {
                self.approaches[i].as_ref().is_some_and(|a| {
                    self.escape_seconds(a.station, step, i, &a.route, agents) <= seconds[i] * 1.15
                })
            });
            if !keep && !self.traversing(i) {
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
        // Pursuit keeps its existing physical-map navigation. Evacuation
        // approaches below use only each person's learned obstruction map.
        if self.scenario.pursuit.is_some()
            && self.stations.iter().any(|s| s.eligible)
            && (0..agents.len()).any(|i| !evacuated[i] && fallback[i] && !self.controls(i))
        {
            self.prepare_navigation(geometry);
        }
        // Replan only when learned geometry invalidates an approach. Physical
        // collision checks remain authoritative even before an object is seen.
        for (i, agent) in agents.iter().enumerate() {
            if self.traversing(i) || self.scenario.pursuit.is_some() {
                continue;
            }
            let Some(a) = &self.approaches[i] else {
                continue;
            };
            let station = a.station;
            let map = self.beliefs.geometry_for_agent(agent);
            let mut from = agent.position;
            let valid = a.route.waypoints[a.cursor..].iter().all(|&to| {
                let clear = map.can_move(from, to) && map.avoids_known_danger(from, to);
                from = to;
                clear
            });
            if !valid || !self.believed_usable(station, agent, geometry) {
                self.cancel(i);
            }
        }
        let mut attempted = false;
        for i in 0..agents.len() {
            if evacuated[i]
                || (exit_seconds.is_none() && !fallback[i])
                || self.approaches[i].is_some()
            {
                continue;
            }
            let interval = (0.5 / self.scenario.time_step_seconds).ceil().max(1.0) as u32;
            if exit_seconds.is_some() && !step.is_multiple_of(interval) {
                continue;
            }
            attempted = true;
            let mut best: Option<(f64, usize, Route)> = None;
            let candidates: Vec<_> = self.known_windows[i].iter().copied().collect();
            for station in candidates {
                if !self.believed_usable(station, &agents[i], geometry) {
                    continue;
                }
                if let Some(route) = self.approach_route(station, &agents[i], geometry) {
                    reachable[station] = true;
                    let seconds = self.escape_seconds(station, step, i, &route, agents);
                    if best.as_ref().is_none_or(|(cost, _, _)| seconds < *cost) {
                        best = Some((seconds, station, route));
                    }
                }
            }
            if let Some((seconds, station, route)) = best
                && exit_seconds.is_none_or(|normal| seconds + 1.0 < normal[i] * 0.85)
            {
                let estimated_exit_seconds = exit_seconds
                    .map(|normal| normal[i])
                    .filter(|seconds| seconds.is_finite());
                self.decisions.record(crate::models::WindowDecision {
                    step,
                    agent_id: agents[i].id,
                    window_id: self.scenario.windows[station].id.clone(),
                    reason: if estimated_exit_seconds.is_some() {
                        crate::models::WindowDecisionReason::EstimatedFaster
                    } else {
                        crate::models::WindowDecisionReason::NoKnownSafeExit
                    },
                    estimated_window_seconds: seconds,
                    estimated_exit_seconds,
                });
                self.searches[i] = None;
                self.approaches[i] = Some(Approach {
                    station,
                    route,
                    cursor: 0,
                });
            }
        }
        for (station, s) in self.stations.iter_mut().enumerate() {
            if attempted
                && s.eligible
                && !reachable[station]
                && self
                    .known_windows
                    .iter()
                    .any(|known| known.contains(&station))
            {
                s.snapshot.unavailable_reason = Some("No route to the configured indoor approach. Check the exterior direction and intervening barriers.".into());
            }
        }
        // Stable agent order breaks ties for arrivals on the same tick.
        // Disc collisions enforce spacing in the physical holding lane.
        let mut arrivals: Vec<_> = (0..agents.len())
            .filter(|&i| self.approaches[i].is_some() && !self.traversing(i))
            .collect();
        arrivals.sort_by_key(|&i| agents[i].id);
        for i in arrivals {
            let map = if self.scenario.pursuit.is_some() {
                geometry
            } else {
                self.beliefs.geometry_for_agent(&agents[i])
            };
            let a = self.approaches[i].as_mut().unwrap();
            for future in (a.cursor + 1..a.route.waypoints.len()).rev() {
                if map.can_move(agents[i].position, a.route.waypoints[future])
                    && map.avoids_known_danger(agents[i].position, a.route.waypoints[future])
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
            // Earlier route decisions can bring a group to the lane together.
            // Serve the person physically at its front so a queued person
            // farther back cannot wait forever behind the rest of the line.
            s.queue.sort_by(|&a, &b| {
                math::distance_to_point(agents[a].position, s.approach)
                    .total_cmp(&math::distance_to_point(agents[b].position, s.approach))
                    .then_with(|| agents[a].id.cmp(&agents[b].id))
            });
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
        if let Some(search) = &self.searches[i] {
            return Some(search.route.waypoints[search.cursor]);
        }
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
    /// Read-only snapshot of the same approach, queue or traversal guidance used by movement.
    pub(super) fn planned_path(
        &self,
        i: usize,
        position: Point,
        geometry: &Geometry<'_>,
    ) -> Option<AgentPlannedPath> {
        if let Some(search) = &self.searches[i] {
            return Some(AgentPlannedPath::snapshot(
                search.route.waypoints[search.cursor..].iter().copied(),
            ));
        }
        let approach = self.approaches[i].as_ref()?;
        let station = &self.stations[approach.station];
        if station.traverser == Some(i) {
            return Some(AgentPlannedPath::snapshot([station.landing]));
        }
        let remaining = &approach.route.waypoints[approach.cursor..];
        if let Some(target) = self.target(i, position, geometry)
            && remaining
                .first()
                .is_none_or(|point| math::distance_to_point(*point, target) > 1e-8)
        {
            // The controller currently aims at a queue position, not through its neighbors.
            return Some(AgentPlannedPath::snapshot([target]));
        }
        Some(AgentPlannedPath::snapshot(
            remaining.iter().copied().chain([station.landing]),
        ))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn layout() -> BuildingScenario {
        serde_json::from_value(json!({
            "width":20,"height":20,
            "walls":[{"id":"wall","start":{"x":10,"y":0},"end":{"x":10,"y":20},"thickness":0.2}],
            "doors":[],"exits":[{"id":"exit","wall_id":"wall","offset":16,"width":2}],
            "blocked_exit_ids":["exit"],"spawn_zones":[],"obstructions":[],
            "windows":[
                {"id":"near","wall_id":"wall","offset":5,"width":2,
                 "emergency_escape":{"enabled":true,"preparation":"open","clear_width_metres":2,"clear_height_metres":1.2,"preparation_seconds":0,"traversal_seconds":10,"exterior_side":-1,"exterior_available":true}},
                {"id":"other","wall_id":"wall","offset":9,"width":2,
                 "emergency_escape":{"enabled":true,"preparation":"open","clear_width_metres":2,"clear_height_metres":1.2,"preparation_seconds":0,"traversal_seconds":10,"exterior_side":-1,"exterior_available":true}}
            ],
            "window_escape_context":{"floor_elevation_metres":0,"all_agents_can_traverse":true,"required_clear_height_metres":1},
            "agent_radius":0.2,"time_step_seconds":0.1,"max_steps":1000,"seed":42,
            "awareness":{"sight_range_metres":1.1,"communication_range_metres":1.1}
        })).unwrap()
    }

    fn informed(id: u32, x: f64, y: f64) -> Agent {
        let mut agent = Agent::new(id, Point { x, y });
        agent.known_walls.insert(
            "wall".into(),
            vec![super::super::perception::WallSpan {
                start: 0.0,
                end: 20.0,
            }],
        );
        agent
    }

    #[test]
    fn windows_require_sight_or_a_local_one_hop_report() {
        let mut b = layout();
        b.awareness.communication_range_metres = 3.2;
        b.obstructions.push(crate::models::Obstruction {
            id: "screen".into(),
            name: None,
            x: 8.9,
            y: 5.8,
            width: 0.2,
            height: 14.2,
        });
        let geometry = Geometry::new(&b);
        let people = [
            informed(0, 9.0, 5.0),
            informed(1, 8.0, 8.0),
            informed(2, 7.0, 8.0),
        ];
        let mut windows = Windows::new(&b, &[], BTreeSet::from(["exit".into()]), 3, &geometry);
        assert!(windows.known_windows.iter().all(BTreeSet::is_empty));
        windows.update(0, &people, &[false; 3], &[false; 3], &geometry);
        assert!(windows.known_windows[0].contains(&0));
        assert!(windows.known_windows[1].contains(&0));
        assert!(windows.known_windows[2].is_empty());
        // A second service update at the same timestamp must not relay again.
        windows.update(0, &people, &[false; 3], &[false; 3], &geometry);
        assert!(windows.known_windows[2].is_empty());
        windows.update(1, &people, &[false; 3], &[false; 3], &geometry);
        assert!(windows.known_windows[2].contains(&0));
    }

    #[test]
    fn a_discovered_window_competes_on_time_with_a_reachable_exit() {
        let b = layout();
        let geometry = Geometry::new(&b);
        let people = [informed(0, 9.0, 6.0)];
        let mut fast_exit = Windows::new(&b, &[], BTreeSet::new(), 1, &geometry);
        fast_exit.choose(0, &people, &[false], &[2.0], &geometry);
        assert!(!fast_exit.controls(0));
        assert!(fast_exit.decisions.choices.is_empty());
        let mut slow_exit = Windows::new(&b, &[], BTreeSet::new(), 1, &geometry);
        slow_exit.choose(0, &people, &[false], &[60.0], &geometry);
        assert_eq!(slow_exit.approaches[0].as_ref().unwrap().station, 0);
        let choice = &slow_exit.decisions.choices[0];
        assert_eq!(
            choice.reason,
            crate::models::WindowDecisionReason::EstimatedFaster
        );
        assert_eq!(choice.estimated_exit_seconds, Some(60.0));
        assert!(choice.estimated_window_seconds < 60.0);
        assert_eq!(choice.window_id, "near");
        let mut fallback = Windows::new(&b, &[], BTreeSet::new(), 1, &geometry);
        fallback.update(0, &people, &[false], &[true], &geometry);
        assert_eq!(
            fallback.decisions.choices[0].reason,
            crate::models::WindowDecisionReason::NoKnownSafeExit
        );
        assert!(
            fallback.decisions.choices[0]
                .estimated_exit_seconds
                .is_none()
        );
    }

    #[test]
    fn an_unobserved_world_change_does_not_cancel_a_window_approach() {
        let b = layout();
        let geometry = Geometry::new(&b);
        let people = [informed(0, 7.0, 6.0)];
        let mut windows = Windows::new(&b, &[], BTreeSet::new(), 1, &geometry);
        windows.known_windows[0].insert(0); // Previously received a local report.
        windows.choose(0, &people, &[false], &[60.0], &geometry);
        let before =
            serde_json::to_value(&windows.approaches[0].as_ref().unwrap().route.waypoints).unwrap();
        windows.refresh(&[], BTreeSet::from(["exit".into()]), &geometry);
        assert!(windows.approaches[0].is_some());
        windows.choose(1, &people, &[false], &[60.0], &geometry);
        assert_eq!(
            before,
            serde_json::to_value(&windows.approaches[0].as_ref().unwrap().route.waypoints).unwrap()
        );
    }

    #[test]
    fn window_search_uses_beliefs_and_cannot_peek_at_hidden_panes() {
        let mut b = layout();
        b.obstructions.push(crate::models::Obstruction {
            id: "screen".into(),
            name: None,
            x: 7.0,
            y: 0.0,
            width: 0.4,
            height: 14.0,
        });
        let geometry = Geometry::new(&b);
        let mut people = [informed(0, 5.0, 15.0)];
        people[0].known_obstructions.insert("screen".into());
        let mut hidden = Windows::new(&b, &[], BTreeSet::new(), 1, &geometry);
        hidden.choose(0, &people, &[false], &[60.0], &geometry);
        assert!(hidden.known_windows[0].is_empty());
        assert!(hidden.approaches[0].is_none());
        assert!(hidden.searches[0].is_some());
        let mut no_panes = b.clone();
        no_panes.windows.clear();
        no_panes.window_escape_context = None;
        let same_world = Geometry::new(&no_panes);
        let mut empty = Windows::new(&no_panes, &[], BTreeSet::new(), 1, &same_world);
        empty.choose(0, &people, &[false], &[60.0], &same_world);
        assert_eq!(
            serde_json::to_value(&hidden.searches[0].as_ref().unwrap().route.waypoints).unwrap(),
            serde_json::to_value(&empty.searches[0].as_ref().unwrap().route.waypoints).unwrap()
        );
        assert_eq!(
            serde_json::to_value(
                &hidden
                    .planned_path(0, people[0].position, &geometry)
                    .unwrap()
                    .waypoints
            )
            .unwrap(),
            serde_json::to_value(&hidden.searches[0].as_ref().unwrap().route.waypoints).unwrap()
        );

        let mut exhausted = Windows::new(&b, &[], BTreeSet::new(), 1, &geometry);
        exhausted.searched_steps[0] = 120;
        exhausted.choose(0, &people, &[false], &[60.0], &geometry);
        assert!(
            !exhausted.controls(0),
            "an unsuccessful search must return control to normal routing"
        );
        let mut quick = Windows::new(&b, &[], BTreeSet::new(), 1, &geometry);
        quick.choose(0, &people, &[false], &[2.0], &geometry);
        assert!(!quick.controls(0));
    }

    #[test]
    fn furniture_occludes_window_discovery_and_zero_sight_does_not_assign_windows() {
        let mut b = layout();
        b.awareness.sight_range_metres = 10.0;
        b.awareness.communication_range_metres = 0.0;
        b.obstructions.push(crate::models::Obstruction {
            id: "screen".into(),
            name: None,
            x: 8.0,
            y: 4.0,
            width: 0.5,
            height: 8.0,
        });
        let people = [informed(0, 7.0, 6.0)];
        let geometry = Geometry::new(&b);
        let mut windows = Windows::new(&b, &[], BTreeSet::from(["exit".into()]), 1, &geometry);
        windows.update(0, &people, &[false], &[true], &geometry);
        assert!(windows.known_windows[0].is_empty());
        assert!(!windows.controls(0));
        b.obstructions.clear();
        b.awareness.sight_range_metres = 0.0;
        let geometry = Geometry::new(&b);
        let mut windows = Windows::new(&b, &[], BTreeSet::from(["exit".into()]), 1, &geometry);
        windows.update(0, &people, &[false], &[true], &geometry);
        assert!(!windows.controls(0));
    }

    #[test]
    fn approaching_people_reserve_service_and_make_another_window_preferable() {
        let mut b = layout();
        b.awareness.sight_range_metres = 100.0;
        let geometry = Geometry::new(&b);
        let people = [informed(0, 7.0, 8.0), informed(1, 6.0, 8.0)];
        let mut windows = Windows::new(&b, &[], BTreeSet::from(["exit".into()]), 2, &geometry);
        let route = windows.approach_route(0, &people[1], &geometry).unwrap();
        let empty = windows.escape_seconds(0, 0, 1, &route, &people);
        windows.update(0, &people, &[false; 2], &[true; 2], &geometry);
        assert_eq!(windows.approaches[0].as_ref().unwrap().station, 0);
        assert_eq!(windows.approaches[1].as_ref().unwrap().station, 1);
        assert!(
            windows.stations[0].queue.is_empty(),
            "the first reservation is still approaching"
        );
        let busy = windows.escape_seconds(0, 0, 1, &route, &people);
        assert!(
            busy > empty + 8.0,
            "count the earlier person's ten-second traversal"
        );
    }

    #[test]
    fn queue_estimates_include_injured_people_and_remaining_active_service() {
        let mut b = layout();
        b.windows[0]
            .emergency_escape
            .as_mut()
            .unwrap()
            .traversal_seconds = 1.0;
        let geometry = Geometry::new(&b);
        let mut people = [informed(0, 9.6999, 6.55), informed(1, 9.6999, 6.0)];
        let mut windows = Windows::new(&b, &[], BTreeSet::from(["exit".into()]), 2, &geometry);
        let route = windows.approach_route(0, &people[1], &geometry).unwrap();
        let ahead = windows.approach_route(0, &people[0], &geometry).unwrap();
        windows.approaches[0] = Some(Approach {
            station: 0,
            route: ahead,
            cursor: 0,
        });
        windows.stations[0].snapshot.state = WindowState::Open;
        windows.stations[0].queue.push(0);
        let healthy = windows.escape_seconds(0, 0, 1, &route, &people);
        assert!((healthy - 2.0).abs() < 1e-6);
        people[0].injury = 1.0;
        let injured = windows.escape_seconds(0, 0, 1, &route, &people);
        assert!(injured > healthy + 0.8);
        windows.stations[0].queue.clear();
        windows.stations[0].traverser = Some(0);
        windows.stations[0].snapshot.traversal_earliest_finish_step = Some(40);
        // Four seconds of active service remain, then our own one-second crossing.
        let active = windows.escape_seconds(0, 0, 1, &route, &people);
        assert!((active - 5.0).abs() < 1e-6);
    }

    #[test]
    fn window_approach_routes_only_detour_around_discovered_furniture() {
        let mut b = layout();
        b.obstructions.push(crate::models::Obstruction {
            id: "cabinet".into(),
            name: None,
            x: 7.0,
            y: 5.0,
            width: 1.0,
            height: 2.0,
        });
        let geometry = Geometry::new(&b);
        let mut person = informed(0, 5.0, 6.0);
        let mut windows = Windows::new(&b, &[], BTreeSet::from(["exit".into()]), 1, &geometry);
        let optimistic = windows.approach_route(0, &person, &geometry).unwrap();
        assert!(
            optimistic
                .waypoints
                .iter()
                .all(|point| (point.y - 6.0).abs() < 1e-6)
        );
        assert!(!geometry.can_move(person.position, *optimistic.waypoints.last().unwrap()));
        person.known_obstructions.insert("cabinet".into());
        let discovered = windows.approach_route(0, &person, &geometry).unwrap();
        let mut from = person.position;
        for to in discovered.waypoints {
            assert!(geometry.can_move(from, to));
            from = to;
        }
    }
}
