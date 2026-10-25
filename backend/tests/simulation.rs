use exitzero::{
    models::{BuildingScenario, SimulationStatus},
    simulation::simulate,
};
use serde_json::json;
use std::collections::BTreeMap;

fn symmetric_exit(width: f64, blocked: bool, seed: u64) -> BuildingScenario {
    serde_json::from_value(json!({
        "width": 10.0, "height": 10.0,
        "walls": [{"id":"north", "start":{"x":0.0,"y":0.0}, "end":{"x":10.0,"y":0.0}, "thickness":0.2}],
        "doors": [], "exits": [{"id":"out", "wall_id":"north", "offset":5.0-width/2.0,"width":width}],
        "spawn_zones": [
            {"id":"left", "x":0.8,"y":0.8,"width":0.4,"height":0.4,"count":1},
            {"id":"right", "x":8.8,"y":0.8,"width":0.4,"height":0.4,"count":1}
        ],
        "blocked_exit_ids": if blocked { vec!["out"] } else { vec![] },
        "obstructions": [], "agent_radius":0.2,"time_step_seconds":0.1,"max_steps":1000,"seed":seed
    })).unwrap()
}

fn partition_door() -> BuildingScenario {
    serde_json::from_value(json!({
        "width":12,"height":8,
        "walls":[
            {"id":"north","start":{"x":0,"y":0},"end":{"x":12,"y":0},"thickness":0.2},
            {"id":"east","start":{"x":12,"y":0},"end":{"x":12,"y":8},"thickness":0.2},
            {"id":"south","start":{"x":12,"y":8},"end":{"x":0,"y":8},"thickness":0.2},
            {"id":"west","start":{"x":0,"y":8},"end":{"x":0,"y":0},"thickness":0.2},
            {"id":"divider","start":{"x":6,"y":0},"end":{"x":6,"y":8},"thickness":0.2}
        ],
        "doors":[{"id":"door","wall_id":"divider","offset":3,"width":2}],
        "exits":[{"id":"exit","wall_id":"east","offset":3,"width":2}],
        "spawn_zones":[
            {"id":"observer","x":4.9,"y":3.9,"width":0.2,"height":0.2,"count":1},
            {"id":"listener","x":2.9,"y":3.9,"width":0.2,"height":0.2,"count":1}
        ],
        "blocked_exit_ids":[],"obstructions":[],"agent_radius":0.1,
        "time_step_seconds":0.1,"seed":42,"max_steps":400,
        "awareness":{"sight_range_metres":1.5,"communication_range_metres":2.1}
    }))
    .unwrap()
}

#[test]
fn step_zero_door_blocking_enforces_real_collision_and_records_actual_reports() {
    use exitzero::models::{CommunicationEventType, OpeningStateChange};
    let mut b = partition_door();
    b.opening_events = vec![OpeningStateChange {
        step: 0,
        opening_id: "door".into(),
        blocked: true,
    }];
    // Exact JSON produced by the editor remains the existing building contract.
    let b: BuildingScenario = serde_json::from_str(&serde_json::to_string(&b).unwrap()).unwrap();
    let closed = simulate(&b).unwrap();
    closed.validate().unwrap();
    assert_eq!(closed.metrics.evacuated, 0);
    assert_eq!(closed.metrics.remaining, 2);
    assert_eq!(
        closed.frames[0].blocked_opening_ids.as_ref().unwrap(),
        &["door"]
    );
    assert!(
        closed
            .frames
            .iter()
            .flat_map(|frame| &frame.agents)
            .all(|agent| agent.x <= 5.8 + 1e-8)
    );
    let events = closed.communication_events.as_ref().unwrap();
    assert!(events.iter().any(|event| event.step == 0
        && event.event_type == CommunicationEventType::Discovery
        && event.sender_id == 0
        && event.opening_id == "door"
        && event.blocked));
    assert!(events.iter().any(|event| event.step == 0
        && event.event_type == CommunicationEventType::Shared
        && event.sender_id == 0
        && event.recipient_ids == [1]
        && event.opening_id == "door"
        && event.blocked));

    let mut open = b.clone();
    open.opening_events.clear();
    let result = simulate(&open).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.evacuated, 2);

    let mut scheduled = b;
    scheduled.opening_events.push(OpeningStateChange {
        step: 20,
        opening_id: "door".into(),
        blocked: false,
    });
    let result = simulate(&scheduled).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.evacuated, 2);
    assert!(
        !result
            .frames
            .iter()
            .find(|frame| frame.step == 20)
            .unwrap()
            .blocked_opening_ids
            .as_ref()
            .unwrap()
            .contains(&"door".into())
    );
    assert!(
        result
            .communication_events
            .unwrap()
            .iter()
            .any(|event| event.step >= 20 && event.opening_id == "door" && !event.blocked)
    );
}

#[test]
fn unblocking_never_bypasses_physical_barriers_and_exits_keep_existing_semantics() {
    use exitzero::models::{Obstruction, OpeningStateChange, Point, Wall};
    let open = partition_door();
    for obstruction in [true, false] {
        let mut b = open.clone();
        b.opening_events = vec![OpeningStateChange {
            step: 0,
            opening_id: "door".into(),
            blocked: false,
        }];
        if obstruction {
            b.obstructions.push(Obstruction {
                id: "blocker".into(),
                name: None,
                x: 5.7,
                y: 3.0,
                width: 0.6,
                height: 2.0,
            });
        } else {
            b.walls.push(Wall {
                id: "cover".into(),
                name: None,
                start: Point { x: 6.0, y: 3.0 },
                end: Point { x: 6.0, y: 5.0 },
                thickness: 0.2,
            });
        }
        let result = simulate(&b).unwrap();
        result.validate().unwrap();
        assert_eq!(
            result.metrics.evacuated, 0,
            "physical obstruction: {obstruction}"
        );
    }
    let mut b = open;
    b.blocked_exit_ids = vec!["exit".into()];
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.evacuated, 0);
    assert!(
        result
            .communication_events
            .unwrap()
            .iter()
            .any(|event| event.opening_id == "exit" && event.blocked)
    );
    b.blocked_exit_ids.clear();
    assert_eq!(simulate(&b).unwrap().metrics.evacuated, 2);
}

#[test]
fn symmetric_occupants_clear_a_wide_exit_without_overlap_or_teleportation() {
    for seed in [0, 1, 42] {
        let building = symmetric_exit(4.0, false, seed);
        let result = simulate(&building).unwrap();
        result.validate().unwrap();
        assert_eq!(
            result.metrics.status,
            SimulationStatus::Completed,
            "seed {seed}"
        );
        assert_eq!(result.metrics.evacuated, 2);
        assert!(result.metrics.clearance_steps.unwrap() < building.max_steps);
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            serde_json::to_value(simulate(&building).unwrap()).unwrap()
        );
        assert_eq!(result.frames[0].step, 0);
        assert_eq!(result.frames[0].agents.len(), 2);
        let mut recorded_distance: BTreeMap<u32, f64> = BTreeMap::new();
        for pair in result.frames.windows(2) {
            assert_eq!(pair[1].step, pair[0].step + 1);
            let mut moves = Vec::new();
            for agent in &pair[0].agents {
                let next = pair[1].agents.iter().find(|next| next.id == agent.id);
                let Some(next) = next else {
                    // Evacuees can arrive anywhere across the exit. Audit the
                    // final leg using measured distance, without inventing a
                    // movement to its centre. Unit tests also audit the actual
                    // final endpoints inside the simulation tick.
                    let stat = result
                        .analytics
                        .as_ref()
                        .unwrap()
                        .agents
                        .iter()
                        .find(|stat| stat.id == agent.id)
                        .unwrap();
                    assert_eq!(stat.evacuation_step, Some(pair[1].step));
                    assert_eq!(stat.exit_id.as_deref(), Some("out"));
                    let final_distance = stat.distance_metres
                        - recorded_distance.get(&agent.id).copied().unwrap_or(0.0);
                    assert!(final_distance >= -1e-8);
                    assert!(final_distance <= 1.3 * building.time_step_seconds + 1e-8);
                    let nearest_x = agent.x.clamp(3.300001, 6.699999);
                    assert!((nearest_x - agent.x).hypot(agent.y) <= final_distance + 1e-8);
                    continue;
                };
                let end = (next.x, next.y);
                *recorded_distance.entry(agent.id).or_default() +=
                    (end.0 - agent.x).hypot(end.1 - agent.y);
                assert!(
                    (end.0 - agent.x).hypot(end.1 - agent.y)
                        <= 1.3 * building.time_step_seconds + 1e-8
                );
                // Any centre closer than radius to the north wall must be in
                // its actual opening, with disc clearance at both jambs.
                for t in 0..=20 {
                    let fraction = f64::from(t) / 20.0;
                    let x = agent.x + (end.0 - agent.x) * fraction;
                    let y = agent.y + (end.1 - agent.y) * fraction;
                    assert!(y >= -1e-8);
                    if y < 0.3 {
                        assert!((3.2 - 1e-8..=6.8 + 1e-8).contains(&x));
                    }
                }
                moves.push(((agent.x, agent.y), end));
            }
            if moves.len() == 2 {
                let (a, b) = (moves[0], moves[1]);
                let start = (a.0.0 - b.0.0, a.0.1 - b.0.1);
                let velocity = (
                    (a.1.0 - a.0.0) - (b.1.0 - b.0.0),
                    (a.1.1 - a.0.1) - (b.1.1 - b.0.1),
                );
                let square = velocity.0 * velocity.0 + velocity.1 * velocity.1;
                let t = if square == 0.0 {
                    0.0
                } else {
                    (-(start.0 * velocity.0 + start.1 * velocity.1) / square).clamp(0.0, 1.0)
                };
                assert!((start.0 + t * velocity.0).hypot(start.1 + t * velocity.1) >= 0.4 - 1e-8);
            }
        }
    }
}

#[test]
fn recovery_never_evacuates_through_disabled_or_impassable_exits() {
    for building in [
        symmetric_exit(4.0, true, 42),
        symmetric_exit(0.3, false, 42),
    ] {
        let result = simulate(&building).unwrap();
        result.validate().unwrap();
        assert_eq!(result.metrics.status, SimulationStatus::Incomplete);
        assert_eq!(result.metrics.remaining, 2);
        assert_eq!(result.metrics.evacuated, 0);
        assert_eq!(result.metrics.clearance_steps, None);
    }
}

#[test]
fn opening_passability_includes_body_radius_and_rounded_jambs() {
    let mut building = symmetric_exit(0.5, false, 42);
    building.spawn_zones.pop();
    let blocked = simulate(&building).unwrap();
    blocked.validate().unwrap();
    assert_eq!(blocked.metrics.status, SimulationStatus::Incomplete);
    assert_eq!(blocked.metrics.evacuated, 0);
    assert_eq!(blocked.metrics.clearance_steps, None);
    building.exits[0].offset = 4.65;
    building.exits[0].width = 0.7;
    let result = simulate(&building).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(result.metrics.evacuated, 1);
}

#[test]
fn wide_exit_partition_keeps_safe_side_passages_in_real_simulation() {
    let mut building = symmetric_exit(6.0, false, 42);
    building.walls.push(exitzero::models::Wall {
        id: "partition".into(),
        name: None,
        start: exitzero::models::Point { x: 5.0, y: 0.0 },
        end: exitzero::models::Point { x: 5.0, y: 2.0 },
        thickness: 0.2,
    });
    let result = simulate(&building).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(result.metrics.evacuated, 2);
    assert!(
        result.frames[0]
            .blocked_opening_ids
            .as_ref()
            .unwrap()
            .is_empty()
    );
    for pair in result.frames.windows(2) {
        for agent in &pair[0].agents {
            if let Some(next) = pair[1].agents.iter().find(|next| next.id == agent.id) {
                // Each side remains on its side of the thin partition until it evacuates.
                assert!((agent.x - 5.0) * (next.x - 5.0) > 0.0);
                for point in [agent, next] {
                    if point.y <= 2.0 {
                        assert!((point.x - 5.0).abs() >= 0.3 - 1e-8);
                    }
                }
            }
        }
    }
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::to_value(simulate(&building).unwrap()).unwrap()
    );
}
