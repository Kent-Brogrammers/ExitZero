use std::collections::{BTreeMap, BTreeSet};

use super::perception::{self, WallKnowledge};
use super::{Emergency, agent::Agent, geometry::Geometry, math, navigation::Navigation};
use crate::models::{BuildingScenario, CommunicationEventType};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Observation {
    pub blocked: bool,
    pub revision: u32,
}

pub(super) fn blocked_ids(agent: &Agent) -> BTreeSet<String> {
    agent
        .knowledge
        .iter()
        .filter(|(_, state)| state.blocked)
        .map(|(id, _)| id.clone())
        .collect()
}

/// Routing depends on what this person has learned, never on the physical
/// world's hidden blockers. Wall memory contains visible intervals, while
/// opening reports retain their explicit open/closed state and revision.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct BeliefKey {
    blocked_openings: BTreeSet<String>,
    observed_openings: BTreeSet<String>,
    emergencies: BTreeSet<usize>,
    obstructions: BTreeSet<String>,
    walls: WallKnowledge,
    knows_disaster: bool,
    hazard_versions: Vec<(u32, u32)>,
}

impl BeliefKey {
    fn for_agent(agent: &Agent) -> Self {
        Self {
            blocked_openings: blocked_ids(agent),
            observed_openings: agent.knowledge.keys().cloned().collect(),
            emergencies: agent.known_emergencies.clone(),
            obstructions: agent.known_obstructions.clone(),
            walls: agent.known_walls.clone(),
            knows_disaster: agent.knows_disaster,
            hazard_versions: agent
                .known_hazards
                .values()
                .map(|area| (area.id, area.revision))
                .collect(),
        }
    }
}

#[derive(Clone)]
struct Report {
    openings: BTreeMap<String, Observation>,
    emergencies: BTreeSet<usize>,
    obstructions: BTreeSet<String>,
    walls: WallKnowledge,
    knows_disaster: bool,
    hazards: BTreeMap<u32, crate::models::HazardArea>,
}

impl Report {
    fn from_agent(agent: &Agent) -> Self {
        Self {
            openings: agent.knowledge.clone(),
            emergencies: agent.known_emergencies.clone(),
            obstructions: agent.known_obstructions.clone(),
            walls: agent.known_walls.clone(),
            knows_disaster: agent.knows_disaster,
            hazards: agent.known_hazards.clone(),
        }
    }

    fn share_with(&self, agent: &mut Agent, mut record: impl FnMut(u32, &str, bool)) -> bool {
        let mut changed = self.knows_disaster && !agent.knows_disaster;
        agent.knows_disaster |= self.knows_disaster;
        for (&id, area) in &self.hazards {
            if agent
                .known_hazards
                .get(&id)
                .is_none_or(|known| known.revision < area.revision)
            {
                agent.known_hazards.insert(id, *area);
                changed = true;
            }
        }
        for (id, &observation) in &self.openings {
            let previous_blocked = agent.knowledge.get(id).is_some_and(|known| known.blocked);
            let learned = learn(agent, id, observation);
            changed |= learned;
            if learned && previous_blocked != observation.blocked {
                record(agent.id, id, observation.blocked);
            }
        }
        let before = (
            agent.known_emergencies.len(),
            agent.known_obstructions.len(),
            agent.known_walls.len(),
        );
        agent.known_emergencies.extend(&self.emergencies);
        changed |= perception::remember(&mut agent.known_walls, &self.walls);
        agent
            .known_obstructions
            .extend(self.obstructions.iter().cloned());
        changed
            || before
                != (
                    agent.known_emergencies.len(),
                    agent.known_obstructions.len(),
                    agent.known_walls.len(),
                )
    }
}

/// Physical opening states belong to the world. They are never used as an
/// agent's route map until that agent observes them or receives a local report.
pub(super) struct OpeningStates<'a> {
    scenario: &'a BuildingScenario,
    pub states: BTreeMap<String, Observation>,
    desired: BTreeMap<String, bool>,
    event_index: usize,
    revision: u32,
    hazard: Option<super::evolution::HazardEvolution>,
    hazard_changed: bool,
}

impl<'a> OpeningStates<'a> {
    pub fn new(scenario: &'a BuildingScenario) -> Self {
        let physical = Geometry::new(scenario);
        let states: BTreeMap<_, _> = scenario
            .doors
            .iter()
            .chain(&scenario.exits)
            .map(|o| {
                (
                    o.id.clone(),
                    Observation {
                        blocked: physical.opening_is_blocked(&o.id),
                        revision: 1,
                    },
                )
            })
            .collect();
        let desired = states
            .iter()
            .map(|(id, state)| (id.clone(), state.blocked))
            .collect();
        Self {
            scenario,
            states,
            desired,
            event_index: 0,
            revision: 1,
            hazard: scenario
                .disaster
                .map(|d| super::evolution::HazardEvolution::new(d, scenario.seed)),
            hazard_changed: false,
        }
    }

    pub fn disaster_state(&self) -> Option<&crate::models::DisasterState> {
        self.hazard.as_ref().map(|hazard| &hazard.state)
    }

    pub fn prepare_hazards(&mut self, step: u32) -> Option<crate::models::DisasterState> {
        let previous = self.disaster_state().cloned();
        if let Some(hazard) = &mut self.hazard {
            self.hazard_changed |= hazard.advance(step, self.scenario);
        }
        previous
    }

    pub fn blocked(&self) -> BTreeSet<String> {
        self.states
            .iter()
            .filter(|(_, state)| state.blocked)
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn has_pending_changes(&self) -> bool {
        self.hazard.as_ref().is_some_and(|h| h.is_changing())
            || self.event_index < self.scenario.opening_events.len()
            || self
                .desired
                .iter()
                .any(|(id, blocked)| self.states[id].blocked != *blocked)
    }

    pub fn apply(&mut self, step: u32, agents: &[Agent], evacuated: &[bool]) -> bool {
        if let Some(hazard) = &mut self.hazard {
            self.hazard_changed |= hazard.advance(step, self.scenario);
        }
        if let Some(state) = self.disaster_state() {
            let affected: Vec<_> = self
                .scenario
                .doors
                .iter()
                .chain(&self.scenario.exits)
                .filter(|opening| {
                    super::catastrophe::state_blocks_opening(self.scenario, opening, state)
                })
                .map(|opening| opening.id.clone())
                .collect();
            for id in affected {
                self.desired.insert(id, true);
            }
        }
        while let Some(event) = self.scenario.opening_events.get(self.event_index) {
            if event.step > step {
                break;
            }
            let opening = self
                .scenario
                .doors
                .iter()
                .chain(&self.scenario.exits)
                .find(|o| o.id == event.opening_id)
                .unwrap();
            self.desired.insert(
                event.opening_id.clone(),
                event.blocked || Geometry::layout_blocks_opening(self.scenario, opening),
            );
            self.event_index += 1;
        }
        let mut changed = std::mem::take(&mut self.hazard_changed);
        for (id, blocked) in &self.desired {
            if self.states[id].blocked == *blocked {
                continue;
            }
            if *blocked {
                let opening = self
                    .scenario
                    .doors
                    .iter()
                    .chain(&self.scenario.exits)
                    .find(|o| o.id == *id)
                    .unwrap();
                let wall = self
                    .scenario
                    .walls
                    .iter()
                    .find(|w| w.id == opening.wall_id)
                    .unwrap();
                let start = math::interpolate(wall.start, wall.end, opening.offset / wall.length());
                let end = math::interpolate(
                    wall.start,
                    wall.end,
                    (opening.offset + opening.width) / wall.length(),
                );
                if agents.iter().zip(evacuated).any(|(agent, gone)| {
                    !gone
                        && math::distance_to_segment(agent.position, start, end)
                            < self.scenario.agent_radius + wall.thickness / 2.0
                }) {
                    // A closing passage waits until bodies clear it. Never
                    // materialize solid wall geometry inside an occupant.
                    continue;
                }
            }
            self.revision += 1;
            self.states.insert(
                id.clone(),
                Observation {
                    blocked: *blocked,
                    revision: self.revision,
                },
            );
            changed = true;
        }
        changed
    }
}

fn learn(agent: &mut Agent, id: &str, observation: Observation) -> bool {
    if agent
        .knowledge
        .get(id)
        .is_none_or(|known| known.revision < observation.revision)
    {
        agent.knowledge.insert(id.to_owned(), observation);
        true
    } else {
        false
    }
}

/// Observe, then exchange a snapshot. Newly received reports cannot propagate
/// through a whole chain in the same tick or depend on agent iteration order.
pub(super) fn update_knowledge(
    agents: &mut [Agent],
    evacuated: &[bool],
    world: &OpeningStates<'_>,
    geometry: &Geometry<'_>,
    mut record: impl FnMut(CommunicationEventType, u32, &str, bool, Vec<u32>),
) -> (Vec<bool>, bool) {
    let scenario = world.scenario;
    let before: Vec<_> = agents.iter().map(BeliefKey::for_agent).collect();
    let mut informed = false;
    if scenario.awareness.sight_range_metres > 0.0 {
        for (i, agent) in agents.iter_mut().enumerate() {
            if evacuated[i] {
                continue;
            }
            if let Some(disaster) = scenario.disaster {
                for area in &geometry.hazard_areas {
                    let mut footprint = disaster;
                    footprint.center = area.center;
                    footprint.radius = area.radius;
                    let distance = math::distance_to_point(agent.position, area.center);
                    let surface =
                        math::move_toward(area.center, agent.position, footprint.exposure_radius());
                    if distance - footprint.exposure_radius()
                        <= scenario.awareness.sight_range_metres
                        && geometry.has_line_of_sight(agent.position, surface)
                        && agent
                            .known_hazards
                            .get(&area.id)
                            .is_none_or(|known| known.revision < area.revision)
                    {
                        agent.knows_disaster = true;
                        agent.known_hazards.insert(area.id, *area);
                        informed = true;
                    }
                }
            }
            let visible = geometry.visible_walls(
                agent.position,
                scenario.awareness.sight_range_metres,
                &agent.known_walls,
            );
            informed |= perception::remember(&mut agent.known_walls, &visible);
            for opening in scenario.doors.iter().chain(&scenario.exits) {
                if geometry.can_see_opening(
                    agent.position,
                    opening,
                    scenario.awareness.sight_range_metres,
                ) {
                    let observation = world.states[&opening.id];
                    let previous_blocked = agent
                        .knowledge
                        .get(&opening.id)
                        .is_some_and(|known| known.blocked);
                    let learned = learn(agent, &opening.id, observation);
                    informed |= learned;
                    // Agents already assume open. Only accepted state changes
                    // are activity, not routine confirmations on every tick.
                    if learned && previous_blocked != observation.blocked {
                        record(
                            CommunicationEventType::Discovery,
                            agent.id,
                            &opening.id,
                            observation.blocked,
                            Vec::new(),
                        );
                    }
                }
            }
            // See a nearby surface, not a hazard's potentially distant centre.
            // The actual world supplies observations; only learned IDs reach
            // this person's planning geometry.
            for (index, emergency) in geometry.emergencies().iter().enumerate() {
                if agent.known_emergencies.contains(&index) {
                    continue;
                }
                let distance = math::distance_to_point(agent.position, emergency.center);
                let surface = math::move_toward(emergency.center, agent.position, emergency.radius);
                if distance - emergency.radius <= scenario.awareness.sight_range_metres
                    && geometry.has_line_of_sight(agent.position, surface)
                {
                    informed |= agent.known_emergencies.insert(index);
                }
            }
            for obstacle in geometry.obstructions() {
                if agent.known_obstructions.contains(&obstacle.id) {
                    continue;
                }
                if math::distance_to_rectangle(
                    agent.position,
                    obstacle.x,
                    obstacle.y,
                    obstacle.width,
                    obstacle.height,
                ) <= scenario.awareness.sight_range_metres
                    && geometry.can_see_obstruction(agent.position, obstacle)
                {
                    informed |= agent.known_obstructions.insert(obstacle.id.clone());
                }
            }
        }
    }
    if scenario.awareness.communication_range_metres > 0.0 {
        let snapshot: Vec<_> = agents.iter().map(Report::from_agent).collect();
        let mut shared: BTreeMap<(u32, String, bool), BTreeSet<u32>> = BTreeMap::new();
        for i in 0..agents.len() {
            if evacuated[i] {
                continue;
            }
            for j in i + 1..agents.len() {
                if evacuated[j]
                    || math::distance_to_point(agents[i].position, agents[j].position)
                        > scenario.awareness.communication_range_metres
                    || !geometry.has_line_of_sight(agents[i].position, agents[j].position)
                {
                    continue;
                }
                let sender = agents[i].id;
                informed |=
                    snapshot[i].share_with(&mut agents[j], |recipient, opening, blocked| {
                        shared
                            .entry((sender, opening.to_owned(), blocked))
                            .or_default()
                            .insert(recipient);
                    });
                let sender = agents[j].id;
                informed |=
                    snapshot[j].share_with(&mut agents[i], |recipient, opening, blocked| {
                        shared
                            .entry((sender, opening.to_owned(), blocked))
                            .or_default()
                            .insert(recipient);
                    });
            }
        }
        for ((sender, opening, blocked), recipients) in shared {
            record(
                CommunicationEventType::Shared,
                sender,
                &opening,
                blocked,
                recipients.into_iter().collect(),
            );
        }
    }
    (
        agents
            .iter()
            .enumerate()
            .map(|(i, agent)| BeliefKey::for_agent(agent) != before[i])
            .collect(),
        informed,
    )
}

/// Share graphs only between agents with identical beliefs, never by the actual
/// world mask. Bound the cache when many distinct reports exist in a large run.
pub(super) struct BeliefMaps<'a> {
    scenario: &'a BuildingScenario,
    emergencies: &'a [Emergency],
    maps: BTreeMap<BeliefKey, (Geometry<'a>, Option<Navigation>)>,
}

impl<'a> BeliefMaps<'a> {
    pub fn new(scenario: &'a BuildingScenario, emergencies: &'a [Emergency]) -> Self {
        Self {
            scenario,
            emergencies,
            maps: BTreeMap::new(),
        }
    }

    fn ensure_map(&mut self, agent: &Agent) -> BeliefKey {
        let key = BeliefKey::for_agent(agent);
        if !self.maps.contains_key(&key) {
            if self.maps.len() >= 64 {
                self.maps.clear();
            }
            let mut geometry = Geometry::for_beliefs(
                self.scenario,
                self.emergencies,
                key.blocked_openings.clone(),
                &key.observed_openings,
                &key.emergencies,
                &key.obstructions,
                &key.walls,
            );
            if key.knows_disaster {
                geometry.disaster = self.scenario.disaster;
                geometry.hazard_areas = agent.known_hazards.values().copied().collect();
            }
            self.maps.insert(key.clone(), (geometry, None));
        }
        key
    }

    pub fn geometry_for_agent(&mut self, agent: &Agent) -> &Geometry<'a> {
        let key = self.ensure_map(agent);
        &self.maps[&key].0
    }

    pub fn for_agent(&mut self, agent: &Agent) -> (&Geometry<'a>, &Navigation) {
        let key = self.ensure_map(agent);
        let (geometry, navigation) = self.maps.get_mut(&key).unwrap();
        let navigation = navigation.get_or_insert_with(|| Navigation::new(self.scenario, geometry));
        (geometry, navigation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Opening, OpeningStateChange, Point, Wall};

    fn update_knowledge(
        agents: &mut [Agent],
        evacuated: &[bool],
        world: &OpeningStates<'_>,
        geometry: &Geometry<'_>,
    ) -> (Vec<bool>, bool) {
        super::update_knowledge(agents, evacuated, world, geometry, |_, _, _, _, _| {})
    }

    fn scenario() -> BuildingScenario {
        let mut b: BuildingScenario =
            serde_json::from_str(include_str!("../../../shared/examples/building.json")).unwrap();
        b.walls = vec![Wall {
            id: "north".into(),
            name: None,
            start: Point { x: 0.0, y: 0.0 },
            end: Point { x: 20.0, y: 0.0 },
            thickness: 0.2,
        }];
        b.doors.clear();
        b.exits = vec![
            Opening {
                id: "left".into(),
                name: None,
                wall_id: "north".into(),
                offset: 1.0,
                width: 2.0,
            },
            Opening {
                id: "right".into(),
                name: None,
                wall_id: "north".into(),
                offset: 17.0,
                width: 2.0,
            },
        ];
        b.blocked_exit_ids = vec!["left".into()];
        b.awareness.sight_range_metres = 1.5;
        b.awareness.communication_range_metres = 2.1;
        b
    }

    fn at(id: u32, x: f64, y: f64) -> Agent {
        Agent::new(id, Point { x, y })
    }

    fn recorded_tick(
        agents: &mut [Agent],
        evacuated: &[bool],
        world: &OpeningStates<'_>,
        geometry: &Geometry<'_>,
        step: u32,
    ) -> Vec<crate::models::CommunicationEvent> {
        let mut events = Vec::new();
        super::update_knowledge(
            agents,
            evacuated,
            world,
            geometry,
            |event_type, sender_id, opening_id, blocked, recipient_ids| {
                events.push(crate::models::CommunicationEvent {
                    step,
                    event_type,
                    sender_id,
                    opening_id: opening_id.to_owned(),
                    blocked,
                    recipient_ids,
                });
            },
        );
        events
    }

    #[test]
    fn recorded_shares_group_actual_recipients_and_do_not_repeat() {
        let b = scenario();
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        let mut agents = vec![at(0, 2.0, 1.0), at(7, 2.0, 3.0), at(9, 3.0, 2.5)];
        let events = recorded_tick(&mut agents, &[false; 3], &world, &geometry, 4);
        assert_eq!(
            events,
            vec![
                crate::models::CommunicationEvent {
                    step: 4,
                    event_type: CommunicationEventType::Discovery,
                    sender_id: 0,
                    recipient_ids: vec![],
                    opening_id: "left".into(),
                    blocked: true,
                },
                crate::models::CommunicationEvent {
                    step: 4,
                    event_type: CommunicationEventType::Shared,
                    sender_id: 0,
                    recipient_ids: vec![7, 9],
                    opening_id: "left".into(),
                    blocked: true,
                },
            ]
        );
        assert!(recorded_tick(&mut agents, &[false; 3], &world, &geometry, 5).is_empty());
        assert!(
            agents
                .iter()
                .all(|agent| blocked_ids(agent).contains("left"))
        );
    }

    #[test]
    fn recorded_relays_preserve_the_existing_one_hop_per_tick_rule() {
        let b = scenario();
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        let mut agents = vec![at(0, 2.0, 1.0), at(1, 2.0, 3.0), at(2, 2.0, 5.0)];
        let first = recorded_tick(&mut agents, &[false; 3], &world, &geometry, 0);
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].event_type, CommunicationEventType::Discovery);
        assert_eq!(first[1].event_type, CommunicationEventType::Shared);
        assert_eq!((first[1].sender_id, &first[1].recipient_ids), (0, &vec![1]));
        assert!(!agents[2].knowledge.contains_key("left"));
        let relay = recorded_tick(&mut agents, &[false; 3], &world, &geometry, 1);
        assert_eq!(relay.len(), 1);
        assert_eq!(relay[0].event_type, CommunicationEventType::Shared);
        assert_eq!(
            (relay[0].step, relay[0].sender_id, &relay[0].recipient_ids),
            (1, 1, &vec![2])
        );
    }

    #[test]
    fn recorded_door_updates_come_from_actual_closed_door_observations() {
        let mut b = scenario();
        b.doors.push(Opening {
            id: "door".into(),
            name: None,
            wall_id: "north".into(),
            offset: 4.0,
            width: 1.0,
        });
        b.opening_events.push(OpeningStateChange {
            step: 0,
            opening_id: "door".into(),
            blocked: true,
        });
        let mut world = OpeningStates::new(&b);
        assert!(world.apply(0, &[], &[]));
        let geometry = Geometry::with_blocked_openings(&b, &[], world.blocked());
        let mut agents = vec![at(0, 4.5, 1.0), at(1, 4.5, 3.0)];
        let events = recorded_tick(&mut agents, &[false; 2], &world, &geometry, 0);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].opening_id, "door");
        assert_eq!(events[0].event_type, CommunicationEventType::Discovery);
        assert!(events[0].recipient_ids.is_empty());
        assert!(events[0].blocked);
        assert_eq!(events[1].event_type, CommunicationEventType::Shared);
        assert_eq!(events[1].opening_id, "door");
        assert_eq!(events[1].recipient_ids, vec![1]);
    }

    #[test]
    fn independent_discoveries_are_recorded_without_inventing_transfers() {
        let b = scenario();
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        let mut agents = vec![at(0, 2.0, 1.0), at(1, 2.0, 1.2)];
        let events = recorded_tick(&mut agents, &[false; 2], &world, &geometry, 0);
        assert_eq!(events.len(), 2);
        assert_eq!((events[0].sender_id, events[1].sender_id), (0, 1));
        assert!(events.iter().all(|event| {
            event.event_type == CommunicationEventType::Discovery && event.recipient_ids.is_empty()
        }));
        assert!(recorded_tick(&mut agents, &[false; 2], &world, &geometry, 1).is_empty());
        assert!(
            agents
                .iter()
                .all(|agent| blocked_ids(agent).contains("left"))
        );
    }

    #[test]
    fn no_transfers_when_disabled_out_of_range_evacuated_or_occluded() {
        for case in ["disabled", "range", "evacuated", "wall"] {
            let mut b = scenario();
            let mut positions = vec![at(0, 2.0, 1.0), at(1, 2.0, 3.0)];
            let mut gone = [false; 2];
            match case {
                "disabled" => b.awareness.communication_range_metres = 0.0,
                "range" => positions[1].position.y = 9.0,
                "evacuated" => gone[0] = true,
                "wall" => {
                    b.walls.push(Wall {
                        id: "divider".into(),
                        name: None,
                        start: Point { x: 5.0, y: 0.0 },
                        end: Point { x: 5.0, y: 20.0 },
                        thickness: 0.2,
                    });
                    b.awareness.sight_range_metres = 30.0;
                    b.awareness.communication_range_metres = 4.0;
                    positions = vec![at(0, 4.0, 3.0), at(1, 6.0, 3.0)];
                }
                _ => unreachable!(),
            }
            let world = OpeningStates::new(&b);
            let geometry = Geometry::new(&b);
            assert!(
                recorded_tick(&mut positions, &gone, &world, &geometry, 0)
                    .iter()
                    .all(|event| event.event_type == CommunicationEventType::Discovery),
                "{case}"
            );
            assert!(!positions[1].knowledge.contains_key("left"), "{case}");
        }
    }

    #[test]
    fn recorded_chat_includes_reopenings_but_not_stale_or_routine_open_confirmations() {
        let mut b = scenario();
        b.opening_events = vec![OpeningStateChange {
            step: 2,
            opening_id: "left".into(),
            blocked: false,
        }];
        let mut world = OpeningStates::new(&b);
        let mut agents = vec![at(0, 2.0, 1.0), at(1, 2.0, 3.0)];
        let geometry = Geometry::new(&b);
        assert_eq!(
            recorded_tick(&mut agents, &[false; 2], &world, &geometry, 0).len(),
            2
        );
        assert!(world.apply(2, &agents, &[false; 2]));
        let geometry = Geometry::with_blocked_openings(&b, &[], world.blocked());
        let events = recorded_tick(&mut agents, &[false; 2], &world, &geometry, 2);
        assert_eq!(events.len(), 2);
        assert!(!events[0].blocked);
        assert_eq!(events[0].event_type, CommunicationEventType::Discovery);
        assert!(events[0].recipient_ids.is_empty());
        assert!(!events[1].blocked);
        assert_eq!(events[1].event_type, CommunicationEventType::Shared);
        assert_eq!(events[1].recipient_ids, vec![1]);
        assert!(recorded_tick(&mut agents, &[false; 2], &world, &geometry, 3).is_empty());
        agents[0].knowledge.insert(
            "left".into(),
            Observation {
                blocked: true,
                revision: 0,
            },
        );
        agents[0].position = Point { x: 2.0, y: 10.0 };
        agents[1].position = Point { x: 2.0, y: 12.0 };
        // Only the newer reopening can be accepted; the stale blocked report cannot win.
        let events = recorded_tick(&mut agents, &[false; 2], &world, &geometry, 4);
        assert!(
            events
                .iter()
                .all(|event| !event.blocked && event.sender_id == 1)
        );
    }

    #[test]
    fn ordinary_open_scenario_records_no_new_information() {
        let mut b = scenario();
        b.blocked_exit_ids.clear();
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        let mut agents = vec![at(0, 2.0, 1.0), at(1, 2.0, 3.0)];
        for step in 0..3 {
            assert!(recorded_tick(&mut agents, &[false; 2], &world, &geometry, step).is_empty());
        }
    }

    #[test]
    fn seeing_the_near_edge_of_a_closed_exit_is_enough_to_warn_the_group() {
        let mut b = scenario();
        b.exits[0].offset = 1.0;
        b.exits[0].width = 8.0;
        b.awareness.sight_range_metres = 0.75;
        b.awareness.communication_range_metres = 2.1;
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        let mut agents = vec![at(0, 1.5, 0.5), at(1, 1.5, 2.5), at(2, 1.5, 4.5)];
        let (changed, _) = update_knowledge(&mut agents, &[false; 3], &world, &geometry);
        assert!(
            agents[0]
                .knowledge
                .get("left")
                .is_some_and(|state| state.blocked)
        );
        assert!(
            agents[1]
                .knowledge
                .get("left")
                .is_some_and(|state| state.blocked)
        );
        assert!(
            !agents[2].knowledge.contains_key("left"),
            "no same-tick chain broadcast"
        );
        assert!(changed[0] && changed[1]);
        update_knowledge(&mut agents, &[false; 3], &world, &geometry);
        assert!(
            agents[2]
                .knowledge
                .get("left")
                .is_some_and(|state| state.blocked)
        );
        let mut maps = BeliefMaps::new(&b, &[]);
        let (map, navigation) = maps.for_agent(&agents[2]);
        assert_eq!(
            navigation
                .find_route(agents[2].position, map)
                .unwrap()
                .exit_id,
            "right"
        );
    }

    #[test]
    fn reported_fire_and_gas_rule_out_an_exit_before_the_recipient_can_see_it() {
        use crate::models::{Disaster, DisasterKind};
        for kind in [DisasterKind::Fire, DisasterKind::GasLeak] {
            let mut b = scenario();
            b.blocked_exit_ids.clear();
            b.awareness.sight_range_metres = 0.6;
            b.disaster = Some(Disaster {
                kind,
                center: Point { x: 2.0, y: 0.2 },
                radius: 0.2,
                dynamics: None,
            });
            let world = OpeningStates::new(&b);
            let geometry = Geometry::new(&b);
            let mut agents = vec![
                at(0, 2.0, 1.0),
                at(1, 2.0, 3.0),
                at(2, 2.0, 5.0),
                at(3, 2.0, 9.0),
            ];
            let mut maps = BeliefMaps::new(&b, &[]);
            let (changed, _) = update_knowledge(&mut agents, &[false; 4], &world, &geometry);
            assert!(changed[0] && changed[1]);
            assert!(
                !agents[1].knowledge.contains_key("left"),
                "the receiver cannot see the exit"
            );
            assert!(
                agents[1].known_hazards.contains_key(&0),
                "the witness reports the hazard's location"
            );
            let (map, navigation) = maps.for_agent(&agents[1]);
            assert!(
                map.opening_is_unsafe("left"),
                "{kind:?} makes that destination unsafe"
            );
            assert_eq!(
                navigation
                    .find_route(agents[1].position, map)
                    .unwrap()
                    .exit_id,
                "right"
            );
            let (map, navigation) = maps.for_agent(&agents[2]);
            assert!(!map.opening_is_unsafe("left"), "no instantaneous relay");
            assert_eq!(
                navigation
                    .find_route(agents[2].position, map)
                    .unwrap()
                    .exit_id,
                "left"
            );
            update_knowledge(&mut agents, &[false; 4], &world, &geometry);
            assert!(
                maps.geometry_for_agent(&agents[2])
                    .opening_is_unsafe("left")
            );
            assert!(
                !maps
                    .geometry_for_agent(&agents[3])
                    .opening_is_unsafe("left"),
                "out-of-range groups remain unaware"
            );
        }
    }

    #[test]
    fn a_closed_door_blocks_fire_reports_until_there_is_a_clear_path() {
        let mut b = scenario();
        b.awareness.sight_range_metres = 0.6;
        b.disaster = Some(crate::models::Disaster {
            kind: crate::models::DisasterKind::Fire,
            center: Point { x: 2.0, y: 0.2 },
            radius: 0.2,
            dynamics: None,
        });
        b.walls.push(Wall {
            id: "divider".into(),
            name: None,
            start: Point { x: 0.0, y: 2.0 },
            end: Point { x: 20.0, y: 2.0 },
            thickness: 0.2,
        });
        b.doors.push(Opening {
            id: "door".into(),
            name: None,
            wall_id: "divider".into(),
            offset: 1.0,
            width: 2.0,
        });
        b.opening_events = vec![
            OpeningStateChange {
                step: 0,
                opening_id: "door".into(),
                blocked: true,
            },
            OpeningStateChange {
                step: 1,
                opening_id: "door".into(),
                blocked: false,
            },
        ];
        let mut world = OpeningStates::new(&b);
        let mut agents = vec![at(0, 2.0, 1.0), at(1, 2.0, 3.0)];
        world.apply(0, &agents, &[false; 2]);
        let geometry = Geometry::with_blocked_openings(&b, &[], world.blocked());
        update_knowledge(&mut agents, &[false; 2], &world, &geometry);
        assert!(agents[0].known_hazards.contains_key(&0));
        assert!(agents[1].known_hazards.is_empty());
        world.apply(1, &agents, &[false; 2]);
        let geometry = Geometry::with_blocked_openings(&b, &[], world.blocked());
        update_knowledge(&mut agents, &[false; 2], &world, &geometry);
        assert!(agents[1].known_hazards.contains_key(&0));
        assert!(
            BeliefMaps::new(&b, &[])
                .geometry_for_agent(&agents[1])
                .opening_is_unsafe("left")
        );
    }

    #[test]
    fn a_reported_hazard_does_not_create_solid_wall_inside_an_occupied_doorway() {
        let mut b = scenario();
        b.blocked_exit_ids.clear();
        b.disaster = Some(crate::models::Disaster {
            kind: crate::models::DisasterKind::GasLeak,
            center: Point { x: 2.0, y: 2.0 },
            radius: 0.1,
            dynamics: Some(crate::models::DisasterDynamics {
                growth_rate: 0.2,
                max_radius: 1.5,
                max_patches: 1,
                ..Default::default()
            }),
        });
        let mut world = OpeningStates::new(&b);
        let mut agents = vec![at(0, 2.0, 0.1)];
        world.apply(60, &agents, &[false]);
        assert!(
            !world.states["left"].blocked,
            "closure waits for the occupant to clear"
        );
        let mut geometry = Geometry::with_blocked_openings(&b, &[], world.blocked());
        geometry.hazard_areas = world.disaster_state().unwrap().areas.clone();
        update_knowledge(&mut agents, &[false], &world, &geometry);
        let mut maps = BeliefMaps::new(&b, &[]);
        let (map, navigation) = maps.for_agent(&agents[0]);
        assert!(map.opening_is_unsafe("left"));
        assert!(map.can_stand_at(agents[0].position));
        assert_eq!(
            navigation
                .find_route(agents[0].position, map)
                .unwrap()
                .exit_id,
            "right"
        );
    }

    #[test]
    fn agents_assume_open_until_they_see_or_receive_a_local_report() {
        let b = scenario();
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        let mut agents = vec![
            at(0, 2.0, 1.0),
            at(1, 2.0, 3.0),
            at(2, 2.0, 5.0),
            at(3, 2.0, 9.0),
        ];
        let mut maps = BeliefMaps::new(&b, &[]);
        let (map, navigation) = maps.for_agent(&agents[2]);
        assert_eq!(
            navigation
                .find_route(agents[2].position, map)
                .unwrap()
                .exit_id,
            "left"
        );
        let (changed, _) = update_knowledge(&mut agents, &[false; 4], &world, &geometry);
        assert_eq!(changed, vec![true, true, false, false]);
        assert!(
            blocked_ids(&agents[2]).is_empty(),
            "no instantaneous relay down the chain"
        );
        let (map, navigation) = maps.for_agent(&agents[1]);
        assert_eq!(
            navigation
                .find_route(agents[1].position, map)
                .unwrap()
                .exit_id,
            "right"
        );
        update_knowledge(&mut agents, &[false; 4], &world, &geometry);
        assert!(blocked_ids(&agents[2]).contains("left"));
        assert!(
            blocked_ids(&agents[3]).is_empty(),
            "out-of-range agents remain unaware"
        );
    }

    #[test]
    fn zero_communication_range_disables_sharing_and_evacuated_agents_do_not_broadcast() {
        let mut b = scenario();
        b.awareness.communication_range_metres = 0.0;
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        let mut agents = vec![at(0, 2.0, 1.0), at(1, 2.0, 3.0)];
        update_knowledge(&mut agents, &[false; 2], &world, &geometry);
        assert!(blocked_ids(&agents[0]).contains("left"));
        assert!(agents[1].knowledge.is_empty());
        b.awareness.communication_range_metres = 3.0;
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        update_knowledge(&mut agents, &[true, false], &world, &geometry);
        assert!(agents[1].knowledge.is_empty());
    }

    #[test]
    fn walls_occlude_observations_and_communication() {
        let mut b = scenario();
        b.walls.push(Wall {
            id: "divider".into(),
            name: None,
            start: Point { x: 5.0, y: 0.0 },
            end: Point { x: 5.0, y: 20.0 },
            thickness: 0.2,
        });
        b.awareness.sight_range_metres = 30.0;
        b.awareness.communication_range_metres = 4.0;
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        let mut agents = vec![at(0, 4.0, 3.0), at(1, 6.0, 3.0)];
        update_knowledge(&mut agents, &[false; 2], &world, &geometry);
        assert!(blocked_ids(&agents[0]).contains("left"));
        assert!(!agents[1].knowledge.contains_key("left"));
    }

    #[test]
    fn a_wall_near_the_exit_centre_still_hides_its_state() {
        let mut b = scenario();
        b.walls[0].thickness = 2.0;
        b.exits[0].offset = 0.0;
        b.exits[0].width = 4.0;
        b.walls.push(Wall {
            id: "screen".into(),
            name: None,
            start: Point { x: 0.0, y: 0.5 },
            end: Point { x: 4.0, y: 0.5 },
            thickness: 0.2,
        });
        b.awareness.sight_range_metres = 8.0;
        b.awareness.communication_range_metres = 0.0;
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        let mut agents = vec![at(0, 2.0, 4.0)];
        assert!(geometry.can_stand_at(agents[0].position));
        update_knowledge(&mut agents, &[false], &world, &geometry);
        assert!(
            !agents[0].knowledge.contains_key("left"),
            "the intervening wall must occlude the full sight ray"
        );
    }

    #[test]
    fn very_thin_walls_block_both_sight_and_reports() {
        let mut b = scenario();
        b.walls.push(Wall {
            id: "thin-divider".into(),
            name: None,
            start: Point { x: 5.0, y: 0.0 },
            end: Point { x: 5.0, y: 20.0 },
            thickness: 1e-10,
        });
        b.awareness.sight_range_metres = 30.0;
        b.awareness.communication_range_metres = 4.0;
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        let mut agents = vec![at(0, 4.0, 3.0), at(1, 6.0, 3.0)];
        update_knowledge(&mut agents, &[false; 2], &world, &geometry);
        assert!(blocked_ids(&agents[0]).contains("left"));
        assert!(
            !agents[1].knowledge.contains_key("left"),
            "a wall crossing stays opaque at any positive thickness"
        );
        b.awareness.sight_range_metres = 0.0;
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        update_knowledge(&mut agents, &[false; 2], &world, &geometry);
        assert!(
            !agents[1].knowledge.contains_key("left"),
            "reports must not cross the thin wall either"
        );
    }

    #[test]
    fn example_agents_do_not_learn_the_left_closure_from_behind_a_corner() {
        let mut b: BuildingScenario =
            serde_json::from_str(include_str!("../../../shared/examples/building.json")).unwrap();
        b.blocked_exit_ids = vec!["west".into()];
        // Add a wall between the example's west spawn zone and west exit.
        // The wall joins the west boundary, forcing a detour at its right end.
        b.walls.push(Wall {
            id: "corner".into(),
            name: None,
            start: Point { x: 2.0, y: 9.0 },
            end: Point { x: 8.0, y: 9.0 },
            thickness: 0.2,
        });
        b.validate().unwrap();
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        let mut agents = Vec::new();
        super::super::agent::spawn_agents(&mut agents, &b, &geometry).unwrap();
        let gone = vec![false; agents.len()];
        update_knowledge(&mut agents, &gone, &world, &geometry);
        assert!(
            agents.iter().all(|a| !a.knowledge.contains_key("west")),
            "the hidden exit must not be known at spawn"
        );
        let mut beliefs = BeliefMaps::new(&b, &[]);
        let (map, navigation) = beliefs.for_agent(&agents[0]);
        assert_eq!(
            navigation
                .find_route(agents[0].position, map)
                .unwrap()
                .exit_id,
            "west"
        );
        for _ in 0..10 {
            update_knowledge(&mut agents, &gone, &world, &geometry);
        }
        assert!(
            agents.iter().all(|a| !a.knowledge.contains_key("west")),
            "gossip cannot invent a report nobody witnessed"
        );
        // A witness rounds the corner; the agent immediately across the solid
        // wall still cannot hear it, despite being within communication range.
        agents[0].position = Point { x: 7.0, y: 9.5 };
        agents[1].position = Point { x: 7.0, y: 8.0 };
        update_knowledge(&mut agents, &gone, &world, &geometry);
        assert!(blocked_ids(&agents[0]).contains("west"));
        assert!(!agents[1].knowledge.contains_key("west"));
        // Once the second agent reaches the same side it can learn directly
        // or hear the witness, then choose the remaining exit.
        agents[1].position = Point { x: 8.5, y: 9.5 };
        update_knowledge(&mut agents, &gone, &world, &geometry);
        assert!(blocked_ids(&agents[1]).contains("west"));
        let (map, navigation) = beliefs.for_agent(&agents[1]);
        assert_eq!(
            navigation
                .find_route(agents[1].position, map)
                .unwrap()
                .exit_id,
            "east"
        );
    }

    #[test]
    fn fresh_reopening_reports_override_stale_closures() {
        let mut b = scenario();
        b.opening_events = vec![OpeningStateChange {
            step: 2,
            opening_id: "left".into(),
            blocked: false,
        }];
        let mut world = OpeningStates::new(&b);
        let mut agents = vec![at(0, 2.0, 1.0), at(1, 2.0, 3.0), at(2, 2.0, 5.0)];
        let geometry = Geometry::new(&b);
        update_knowledge(&mut agents, &[false; 3], &world, &geometry);
        update_knowledge(&mut agents, &[false; 3], &world, &geometry);
        let stale = agents[2].knowledge["left"];
        assert!(world.apply(2, &agents, &[false; 3]));
        let geometry = Geometry::with_blocked_openings(&b, &[], world.blocked());
        update_knowledge(&mut agents, &[false; 3], &world, &geometry);
        assert!(!agents[1].knowledge["left"].blocked);
        assert!(agents[2].knowledge["left"].blocked);
        assert!(!learn(&mut agents[1], "left", stale));
        update_knowledge(&mut agents, &[false; 3], &world, &geometry);
        assert!(!agents[2].knowledge["left"].blocked);
    }

    #[test]
    fn physical_closures_wait_until_occupants_clear_the_opening() {
        let mut b = scenario();
        b.blocked_exit_ids.clear();
        b.opening_events = vec![OpeningStateChange {
            step: 1,
            opening_id: "left".into(),
            blocked: true,
        }];
        let mut world = OpeningStates::new(&b);
        let mut agents = vec![at(0, 2.0, 0.1)];
        assert!(!world.apply(1, &agents, &[false]));
        assert!(!world.states["left"].blocked);
        assert!(world.has_pending_changes());
        agents[0].position.y = 1.0;
        assert!(world.apply(2, &agents, &[false]));
        assert!(world.states["left"].blocked);
        assert!(!world.has_pending_changes());
    }
    #[test]
    fn a_hazard_is_absent_from_the_route_map_until_discovered() {
        let b = scenario();
        let emergencies = [Emergency {
            center: Point { x: 2.0, y: 5.0 },
            radius: 1.0,
        }];
        let geometry = Geometry::with_emergencies(&b, &emergencies);
        let world = OpeningStates::new(&b);
        let mut agents = vec![at(0, 2.0, 9.0)];
        let mut maps = BeliefMaps::new(&b, &emergencies);
        let target = Point { x: 2.0, y: 0.0 };
        let (map, navigation) = maps.for_agent(&agents[0]);
        assert!(map.emergencies().is_empty());
        assert!(map.can_move(agents[0].position, target));
        assert_eq!(
            navigation
                .find_route(agents[0].position, map)
                .unwrap()
                .waypoints
                .len(),
            1
        );
        assert!(!geometry.can_move(agents[0].position, target));
        let (changed, _) = update_knowledge(&mut agents, &[false], &world, &geometry);
        assert_eq!(changed, [false]);
        agents[0].position = Point { x: 2.0, y: 7.0 };
        let (changed, _) = update_knowledge(&mut agents, &[false], &world, &geometry);
        assert_eq!(changed, [true]);
        let (map, navigation) = maps.for_agent(&agents[0]);
        assert_eq!(map.emergencies().len(), 1);
        assert!(!map.can_move(agents[0].position, target));
        let route = navigation.find_route(agents[0].position, map).unwrap();
        assert_eq!(route.exit_id, "left");
        let mut from = agents[0].position;
        for to in route.waypoints {
            assert!(map.can_move(from, to));
            assert!(
                math::distance_to_segment(emergencies[0].center, from, to) > 1.0 + b.agent_radius
            );
            from = to;
        }
    }

    #[test]
    fn seeing_an_obstruction_surface_updates_only_the_observers_map() {
        let mut b = scenario();
        b.awareness.communication_range_metres = 0.0;
        b.obstructions.push(crate::models::Obstruction {
            id: "crate".into(),
            name: None,
            x: 1.5,
            y: 4.0,
            width: 1.0,
            height: 1.0,
        });
        let geometry = Geometry::new(&b);
        let world = OpeningStates::new(&b);
        let mut agents = vec![at(0, 2.0, 6.0), at(1, 2.0, 9.0)];
        let mut maps = BeliefMaps::new(&b, &[]);
        assert_eq!(maps.for_agent(&agents[0]).0.obstructions().count(), 0);
        let (changed, _) = update_knowledge(&mut agents, &[false; 2], &world, &geometry);
        assert_eq!(changed, [true, false]);
        let (map, navigation) = maps.for_agent(&agents[0]);
        assert_eq!(map.obstructions().count(), 1);
        assert!(!map.can_move(agents[0].position, Point { x: 2.0, y: 0.0 }));
        assert!(navigation.find_route(agents[0].position, map).is_some());
        assert_eq!(maps.for_agent(&agents[1]).0.obstructions().count(), 0);
    }

    #[test]
    fn hazard_reports_travel_one_hop_and_cannot_cross_a_wall() {
        let mut b = scenario();
        b.obstructions.push(crate::models::Obstruction {
            id: "debris".into(),
            name: None,
            x: 3.0,
            y: 1.0,
            width: 0.5,
            height: 0.5,
        });
        let emergencies = [Emergency {
            center: Point { x: 2.0, y: 1.0 },
            radius: 0.4,
        }];
        let world = OpeningStates::new(&b);
        let geometry = Geometry::with_emergencies(&b, &emergencies);
        let mut agents = vec![
            at(0, 2.0, 2.0),
            at(1, 2.0, 4.0),
            at(2, 2.0, 6.0),
            at(3, 2.0, 10.0),
        ];
        update_knowledge(&mut agents, &[false; 4], &world, &geometry);
        assert!(agents[0].known_emergencies.contains(&0));
        assert!(agents[1].known_emergencies.contains(&0));
        assert!(agents[1].known_obstructions.contains("debris"));
        assert!(agents[2].known_emergencies.is_empty());
        assert!(agents[2].known_obstructions.is_empty());
        update_knowledge(&mut agents, &[false; 4], &world, &geometry);
        assert!(agents[2].known_emergencies.contains(&0));
        assert!(agents[2].known_obstructions.contains("debris"));
        assert!(agents[3].known_emergencies.is_empty());

        b.walls.push(Wall {
            id: "screen".into(),
            name: None,
            start: Point { x: 0.0, y: 3.0 },
            end: Point { x: 5.0, y: 3.0 },
            thickness: 0.2,
        });
        let world = OpeningStates::new(&b);
        let geometry = Geometry::with_emergencies(&b, &emergencies);
        let mut agents = vec![at(0, 2.0, 2.0), at(1, 2.0, 4.0)];
        for _ in 0..3 {
            update_knowledge(&mut agents, &[false; 2], &world, &geometry);
        }
        assert!(agents[0].known_emergencies.contains(&0));
        assert!(agents[1].known_emergencies.is_empty());
        assert!(agents[1].known_obstructions.is_empty());
    }

    #[test]
    fn obstructions_hide_hazards_and_other_obstructions() {
        let mut b = scenario();
        b.awareness.sight_range_metres = 10.0;
        b.awareness.communication_range_metres = 0.0;
        b.obstructions = vec![
            crate::models::Obstruction {
                id: "screen".into(),
                name: None,
                x: 1.0,
                y: 3.0,
                width: 2.0,
                height: 0.1,
            },
            crate::models::Obstruction {
                id: "hidden".into(),
                name: None,
                x: 1.5,
                y: 1.0,
                width: 1.0,
                height: 0.5,
            },
        ];
        let emergencies = [Emergency {
            center: Point { x: 2.0, y: 2.0 },
            radius: 0.2,
        }];
        let world = OpeningStates::new(&b);
        let geometry = Geometry::with_emergencies(&b, &emergencies);
        let mut agents = vec![at(0, 2.0, 4.0)];
        update_knowledge(&mut agents, &[false], &world, &geometry);
        assert!(agents[0].known_obstructions.contains("screen"));
        assert!(!agents[0].known_obstructions.contains("hidden"));
        assert!(agents[0].known_emergencies.is_empty());
    }

    #[test]
    fn skipping_remembered_wall_pieces_preserves_all_observations() {
        let b = scenario();
        let mut remembered = WallKnowledge::new();
        let mut reference = WallKnowledge::new();
        // Include an opening-state change: new solid material must be seen,
        // while opening observations remain independent of static wall memory.
        for blocked in [false, true, false] {
            let geometry = Geometry::with_blocked_openings(
                &b,
                &[],
                if blocked {
                    BTreeSet::from(["left".into()])
                } else {
                    BTreeSet::new()
                },
            );
            for (x, y) in [(1.0, 1.0), (5.0, 2.0), (10.0, 2.0), (19.0, 1.0), (1.0, 1.0)] {
                let from = Point { x, y };
                let full = geometry.visible_walls(from, 30.0, &WallKnowledge::new());
                let updates = geometry.visible_walls(from, 30.0, &remembered);
                perception::remember(&mut reference, &full);
                perception::remember(&mut remembered, &updates);
                assert_eq!(remembered, reference);
            }
        }
    }

    #[test]
    fn hazard_visibility_measures_range_to_the_near_surface() {
        let b = scenario();
        let emergencies = [Emergency {
            center: Point { x: 10.0, y: 10.0 },
            radius: 5.0,
        }];
        let world = OpeningStates::new(&b);
        let geometry = Geometry::with_emergencies(&b, &emergencies);
        let mut agents = vec![at(0, 10.0, 16.0)];
        update_knowledge(&mut agents, &[false], &world, &geometry);
        assert!(agents[0].known_emergencies.contains(&0));
    }
    #[test]
    fn confirming_an_opening_replaces_optimistic_geometry_with_its_known_layout() {
        let mut b = scenario();
        b.blocked_exit_ids.clear();
        b.walls.push(Wall {
            id: "partial_seal".into(),
            name: None,
            start: Point { x: 2.2, y: 0.0 },
            end: Point { x: 4.0, y: 0.0 },
            thickness: 0.2,
        });
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        assert!(!world.states["left"].blocked);
        let mut agents = vec![at(0, 2.0, 1.0)];
        let mut maps = BeliefMaps::new(&b, &[]);
        let (map, navigation) = maps.for_agent(&agents[0]);
        assert_eq!(
            navigation
                .find_route(agents[0].position, map)
                .unwrap()
                .exit_id,
            "left"
        );
        let (changed, _) = update_knowledge(&mut agents, &[false], &world, &geometry);
        assert_eq!(changed, [true]);
        assert!(!agents[0].knowledge["left"].blocked);
        let (map, navigation) = maps.for_agent(&agents[0]);
        assert!(!map.can_stand_at(Point { x: 2.0, y: 0.0 }));
        let route = navigation.find_route(agents[0].position, map).unwrap();
        // The centre is sealed, but the usable left edge remains reachable.
        assert_eq!(route.exit_id, "left");
        let mut from = agents[0].position;
        for to in route.waypoints {
            assert!(map.can_move(from, to));
            from = to;
        }
        assert!(from.x < 1.9);
    }
    #[test]
    fn an_unseen_enclosure_does_not_rule_out_the_nearest_exit() {
        let mut b = scenario();
        b.blocked_exit_ids.clear();
        b.awareness.sight_range_metres = 1.0;
        b.awareness.communication_range_metres = 0.0;
        b.walls.extend([
            Wall {
                id: "front".into(),
                name: None,
                start: Point { x: 0.0, y: 3.0 },
                end: Point { x: 4.0, y: 3.0 },
                thickness: 0.2,
            },
            Wall {
                id: "side".into(),
                name: None,
                start: Point { x: 4.0, y: 0.0 },
                end: Point { x: 4.0, y: 3.0 },
                thickness: 0.2,
            },
        ]);
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        let physical_routes = Navigation::new(&b, &geometry);
        let mut agents = vec![at(0, 2.0, 8.0)];
        assert_eq!(
            physical_routes
                .find_route(agents[0].position, &geometry)
                .unwrap()
                .exit_id,
            "right"
        );
        let mut maps = BeliefMaps::new(&b, &[]);
        update_knowledge(&mut agents, &[false], &world, &geometry);
        assert!(agents[0].known_walls.is_empty());
        let (map, navigation) = maps.for_agent(&agents[0]);
        assert_eq!(
            navigation
                .find_route(agents[0].position, map)
                .unwrap()
                .exit_id,
            "left"
        );
        agents[0].position = Point { x: 2.0, y: 4.05 };
        update_knowledge(&mut agents, &[false], &world, &geometry);
        assert!(agents[0].known_walls.contains_key("front"));
        assert!(
            !agents[0].known_walls.contains_key("side"),
            "the front wall hides the side's nearest surface"
        );
        let (map, navigation) = maps.for_agent(&agents[0]);
        assert_eq!(
            navigation
                .find_route(agents[0].position, map)
                .unwrap()
                .exit_id,
            "left",
            "knowing one barrier must not reveal the rest of the enclosure"
        );
        agents[0].position = Point { x: 4.6, y: 2.0 };
        update_knowledge(&mut agents, &[false], &world, &geometry);
        assert!(agents[0].known_walls.contains_key("side"));
        let (map, navigation) = maps.for_agent(&agents[0]);
        assert_eq!(
            navigation
                .find_route(agents[0].position, map)
                .unwrap()
                .exit_id,
            "left",
            "two small observations do not reveal the complete enclosure"
        );
        let side = &agents[0].known_walls["side"];
        assert!(side.iter().all(|span| span.start > 0.0 || span.end < 3.0));
    }

    #[test]
    fn discovered_walls_are_reported_one_hop_within_range() {
        let mut b = scenario();
        b.awareness.sight_range_metres = 0.75;
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        let mut agents = vec![
            at(0, 10.0, 0.8),
            at(1, 10.0, 2.8),
            at(2, 10.0, 4.8),
            at(3, 10.0, 9.0),
        ];
        update_knowledge(&mut agents, &[false; 4], &world, &geometry);
        assert!(agents[0].known_walls.contains_key("north"));
        assert!(agents[1].known_walls.contains_key("north"));
        assert!(agents[2].known_walls.is_empty());
        update_knowledge(&mut agents, &[false; 4], &world, &geometry);
        assert!(agents[2].known_walls.contains_key("north"));
        assert!(agents[3].known_walls.is_empty());
    }
    #[test]
    fn seeing_or_reporting_a_sliver_does_not_reveal_the_whole_wall() {
        let mut b = scenario();
        b.awareness.sight_range_metres = 1.5;
        let world = OpeningStates::new(&b);
        let geometry = Geometry::new(&b);
        let mut agents = vec![at(0, 2.0, 1.0), at(1, 2.0, 3.0)];
        update_knowledge(&mut agents, &[false; 2], &world, &geometry);
        assert!(agents[0].knowledge.contains_key("left"));
        assert_eq!(
            agents[0].known_walls, agents[1].known_walls,
            "the receiver must get only the witness's observed intervals"
        );
        let spans = &agents[0].known_walls["north"];
        assert!(!spans.is_empty());
        assert!(spans.iter().all(|span| span.start > 0.0 && span.end < 5.0));
        let mut maps = BeliefMaps::new(&b, &[]);
        let map = maps.geometry_for_agent(&agents[1]);
        assert!(
            map.wall_fragments()
                .all(|(start, end, _)| start.x > 0.0 && end.x < 5.0)
        );
        assert!(
            map.can_move(Point { x: 12.0, y: 2.0 }, Point { x: 12.0, y: 0.0 }),
            "unseen distant wall material must not appear in the receiver's planning map"
        );
    }

    #[test]
    fn looking_along_a_wall_reveals_only_the_near_end_cap() {
        let b = scenario();
        let geometry = Geometry::new(&b);
        let seen = geometry.visible_walls(Point { x: 22.0, y: 0.0 }, 30.0, &WallKnowledge::new());
        let spans = &seen["north"];
        assert!(
            spans
                .iter()
                .all(|span| span.start == 20.0 && span.end == 20.0),
            "a near solid piece must hide the farther pieces of the same wall"
        );
    }
}
