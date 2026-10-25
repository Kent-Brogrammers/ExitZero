use super::{agent::Agent, awareness::can_communicate, geometry::Geometry, math};
use crate::models::{AgentAwareness, Point, PursuitEvent, PursuitEventType};

#[derive(Clone, Copy)]
pub(super) struct Sighting {
    pub position: Point,
    step: u32,
}

pub(super) struct PursuitAwareness {
    pub known: Vec<Option<Sighting>>,
    seen: Vec<bool>,
    pub events: Vec<PursuitEvent>,
}

impl PursuitAwareness {
    pub fn new(count: usize) -> Self {
        Self {
            known: vec![None; count],
            seen: vec![false; count],
            events: vec![],
        }
    }

    /// Observe first, then exchange snapshots: reports travel one hop per tick.
    /// Remember the last reported position; never refresh it from hidden world state.
    pub fn update(
        &mut self,
        step: u32,
        people: &[Agent],
        gone: &[bool],
        stalker: Point,
        settings: &AgentAwareness,
        geometry: &Geometry<'_>,
    ) -> Vec<bool> {
        let mut alerted = vec![false; people.len()];
        for (i, person) in people.iter().enumerate() {
            if !gone[i]
                && settings.sight_range_metres > 0.0
                && math::distance_to_point(person.position, stalker) <= settings.sight_range_metres
                && geometry.has_line_of_sight(person.position, stalker)
            {
                alerted[i] = self.known[i].is_none();
                self.known[i] = Some(Sighting {
                    position: stalker,
                    step,
                });
                if !self.seen[i] {
                    self.seen[i] = true;
                    self.events.push(PursuitEvent {
                        step,
                        event_type: PursuitEventType::Sighting,
                        sender_id: person.id,
                        recipient_ids: vec![],
                        position: stalker,
                    });
                }
            }
        }
        let snapshot = self.known.clone();
        for (i, sender) in people.iter().enumerate() {
            let Some(report) = snapshot[i] else { continue };
            if gone[i] {
                continue;
            }
            let mut recipients = Vec::new();
            for (j, recipient) in people.iter().enumerate() {
                if i == j
                    || gone[j]
                    || !can_communicate(
                        sender.position,
                        recipient.position,
                        settings.communication_range_metres,
                        geometry,
                    )
                {
                    continue;
                }
                if self.known[j].is_none_or(|known| known.step < report.step) {
                    if self.known[j].is_none() {
                        recipients.push(recipient.id);
                        alerted[j] = true;
                    }
                    self.known[j] = Some(report);
                }
            }
            if !recipients.is_empty() {
                self.events.push(PursuitEvent {
                    step,
                    event_type: PursuitEventType::Warning,
                    sender_id: sender.id,
                    recipient_ids: recipients,
                    position: report.position,
                });
            }
        }
        alerted
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scenario() -> crate::models::BuildingScenario {
        serde_json::from_str(include_str!("../../../shared/examples/building.json")).unwrap()
    }
    #[test]
    fn real_sighting_groups_new_recipients_and_relays_only_next_tick_without_spam() {
        let mut b = scenario();
        b.walls.clear();
        b.doors.clear();
        b.exits.clear();
        b.obstructions.clear();
        let geometry = Geometry::new(&b);
        let people: Vec<_> = [1.0, 3.0, 3.1, 5.0]
            .iter()
            .enumerate()
            .map(|(i, &x)| Agent::new(i as u32, Point { x, y: 1.0 }))
            .collect();
        let settings = AgentAwareness {
            sight_range_metres: 1.1,
            communication_range_metres: 2.1,
        };
        let mut knowledge = PursuitAwareness::new(4);
        let stalker = Point { x: 0.0, y: 1.0 };
        let changed = knowledge.update(0, &people, &[false; 4], stalker, &settings, &geometry);
        assert_eq!(changed, vec![true, true, true, false]);
        assert!(knowledge.known[3].is_none());
        assert_eq!(knowledge.events.len(), 2);
        assert_eq!(knowledge.events[1].sender_id, 0);
        assert_eq!(knowledge.events[1].recipient_ids, vec![1, 2]);
        knowledge.update(1, &people, &[false; 4], stalker, &settings, &geometry);
        assert_eq!(knowledge.events.len(), 3);
        assert_eq!(knowledge.events[2].sender_id, 1);
        assert_eq!(knowledge.events[2].recipient_ids, vec![3]);
        for step in 2..10 {
            knowledge.update(step, &people, &[false; 4], stalker, &settings, &geometry);
        }
        assert_eq!(knowledge.events.len(), 3);
        assert_eq!(knowledge.known[3].unwrap().position.x, 0.0);
    }
    #[test]
    fn walls_range_and_inactive_survivors_block_reports_and_hidden_stalker_updates() {
        let mut b = scenario();
        b.walls.clear();
        b.doors.clear();
        b.exits.clear();
        b.obstructions.clear();
        b.walls.push(crate::models::Wall {
            id: "screen".into(),
            name: None,
            start: Point { x: 2.0, y: 0.0 },
            end: Point { x: 2.0, y: 10.0 },
            thickness: 0.1,
        });
        let geometry = Geometry::new(&b);
        let people = vec![
            Agent::new(0, Point { x: 1.0, y: 1.0 }),
            Agent::new(1, Point { x: 3.0, y: 1.0 }),
            Agent::new(2, Point { x: 8.0, y: 1.0 }),
        ];
        let settings = AgentAwareness {
            sight_range_metres: 1.5,
            communication_range_metres: 3.0,
        };
        let mut knowledge = PursuitAwareness::new(3);
        knowledge.update(
            0,
            &people,
            &[false; 3],
            Point { x: 0.5, y: 1.0 },
            &settings,
            &geometry,
        );
        assert_eq!(knowledge.events.len(), 1);
        assert!(knowledge.known[1].is_none());
        assert!(knowledge.known[2].is_none());
        knowledge.update(
            1,
            &people,
            &[true, false, false],
            Point { x: 0.5, y: 2.0 },
            &settings,
            &geometry,
        );
        assert_eq!(knowledge.known[0].unwrap().position.y, 1.0);
        assert_eq!(knowledge.events.len(), 1);
        let mut none = PursuitAwareness::new(3);
        none.update(
            0,
            &people,
            &[false; 3],
            Point { x: 0.5, y: 1.0 },
            &AgentAwareness {
                sight_range_metres: 0.0,
                communication_range_metres: 3.0,
            },
            &geometry,
        );
        assert!(none.events.is_empty());
        let mut disabled = PursuitAwareness::new(3);
        disabled.update(
            0,
            &people,
            &[false; 3],
            Point { x: 0.5, y: 1.0 },
            &AgentAwareness {
                sight_range_metres: 1.5,
                communication_range_metres: 0.0,
            },
            &geometry,
        );
        assert_eq!(disabled.events.len(), 1);
        assert!(disabled.known[1].is_none());
    }
}
