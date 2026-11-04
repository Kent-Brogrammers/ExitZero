use exitzero::{
    models::{BuildingScenario, SimulationResult},
    simulation::{simulate, simulate_live},
};
use serde_json::{Value, json};

#[test]
fn automatic_spawn_modifiers_cover_exact_and_zone_occupants_with_stable_assignments() {
    let mut building = room();
    building.spawn_zones =
        serde_json::from_value(json!([{"id":"area","x":1,"y":2,"width":8,"height":3,"count":12}]))
            .unwrap();
    building.max_steps = 1;
    let neutral = simulate(&building).unwrap();
    building.agent_modifiers = serde_json::from_value(json!([
        {"id":"slow","name":"Slow","speed_multiplier":0.5},
        {"id":"fast","name":"Fast","speed_multiplier":1.2}
    ]))
    .unwrap();
    building.personality_fraction = Some(1.0);
    building.spawn_modifier_ids = Some(vec!["slow".into(), "fast".into()]);
    let first = simulate(&building).unwrap();
    first.validate().unwrap();
    let assigned = &first.agent_modifiers.as_ref().unwrap().agents;
    assert!(assigned.iter().all(|a| {
        a.modifier_ids.len() == 1
            && building
                .spawn_modifier_ids
                .as_ref()
                .unwrap()
                .contains(&a.modifier_ids[0])
    }));
    assert!(assigned.iter().any(|a| a.modifier_ids == ["slow"]));
    assert!(assigned.iter().any(|a| a.modifier_ids == ["fast"]));
    for (a, b) in first.frames[0].agents.iter().zip(&neutral.frames[0].agents) {
        assert_eq!((a.id, a.x, a.y), (b.id, b.x, b.y));
    }
    building.spawn_modifier_ids.as_mut().unwrap().reverse();
    building.agent_modifiers.reverse();
    let repeated = simulate(&building).unwrap();
    assert_eq!(
        serde_json::to_value(assigned).unwrap(),
        serde_json::to_value(&repeated.agent_modifiers.unwrap().agents).unwrap()
    );
    building.blocked_exit_ids.push("exit".into());
    let closed = simulate(&building).unwrap();
    assert_eq!(
        serde_json::to_value(assigned).unwrap(),
        serde_json::to_value(&closed.agent_modifiers.unwrap().agents).unwrap()
    );
    building.blocked_exit_ids.clear();
    building.spawn_modifier_ids = Some(vec!["slow".into()]);
    assert!(
        simulate(&building)
            .unwrap()
            .agent_modifiers
            .unwrap()
            .agents
            .iter()
            .all(|a| a.modifier_ids == ["slow"])
    );
    building.spawn_modifier_ids = Some(vec![]);
    assert!(
        simulate(&building)
            .unwrap()
            .agent_modifiers
            .unwrap()
            .agents
            .iter()
            .all(|a| a.modifier_ids.is_empty() && a.resolved == Default::default())
    );
    building.spawn_modifier_ids = Some(vec!["missing".into()]);
    assert!(building.validate().is_err());
    building.spawn_modifier_ids = Some(vec!["slow".into(), "slow".into()]);
    assert!(building.validate().is_err());
}

#[test]
fn initialization_reports_real_assignments_before_live_frames_and_supports_cancellation() {
    use exitzero::simulation::{SimulationError, simulate_live_with_initialization};
    use std::cell::RefCell;
    let mut building = modified(
        json!([{"id":"slow","name":"Slow","speed_multiplier":0.5}]),
        json!([]),
    );
    building.spawn_modifier_ids = Some(vec!["slow".into()]);
    building.max_steps = 1;
    let order = RefCell::new(Vec::new());
    let mut metadata = None;
    let result = simulate_live_with_initialization(
        &building,
        &mut |_| {
            order.borrow_mut().push("frame");
            true
        },
        &mut |_, _| true,
        &mut |m| {
            order.borrow_mut().push("initialized");
            metadata = Some(m.clone());
            true
        },
    )
    .unwrap();
    assert_eq!(order.borrow()[0], "initialized");
    assert_eq!(
        serde_json::to_value(metadata).unwrap(),
        serde_json::to_value(&result.agent_modifiers).unwrap()
    );
    let mut frames = 0;
    assert!(matches!(
        simulate_live_with_initialization(
            &building,
            &mut |_| {
                frames += 1;
                true
            },
            &mut |_, _| true,
            &mut |_| false
        ),
        Err(SimulationError::Cancelled)
    ));
    assert_eq!(frames, 0);
}

fn room() -> BuildingScenario {
    serde_json::from_value(json!({
        "width":10,"height":10,
        "walls":[{"id":"north","start":{"x":0,"y":0},"end":{"x":10,"y":0},"thickness":0.2}],
        "doors":[],"exits":[{"id":"exit","wall_id":"north","offset":4,"width":2}],
        "spawn_zones":[],"placed_occupants":[{"id":"alice","x":5,"y":7}],
        "blocked_exit_ids":[],"obstructions":[],"agent_radius":0.2,"time_step_seconds":0.1,"seed":42,"max_steps":1000
    })).unwrap()
}

fn modified(definitions: Value, ids: Value) -> BuildingScenario {
    let mut value = serde_json::to_value(room()).unwrap();
    value["agent_modifiers"] = definitions;
    value["placed_occupants"][0]["modifier_ids"] = ids;
    serde_json::from_value(value).unwrap()
}

fn check_caps(building: &BuildingScenario, result: &SimulationResult) {
    result.validate().unwrap();
    let recorded = result.agent_modifiers.as_ref().unwrap();
    for pair in result.frames.windows(2) {
        for before in &pair[0].agents {
            let Some(after) = pair[1].agents.iter().find(|a| a.id == before.id) else {
                continue;
            };
            let assignment = &recorded.agents[before.id as usize];
            let budget = assignment.uninjured_speed_metres_per_second
                * (1.0 - 0.75 * before.injury.unwrap_or(0.0))
                * building.time_step_seconds
                * f64::from(pair[1].step - pair[0].step);
            assert!(
                (before.x - after.x).hypot(before.y - after.y) <= budget + 1e-7,
                "agent {} exceeded its cap",
                before.id
            );
        }
    }
    assert_eq!(
        result.metrics.evacuated + result.metrics.sheltered + result.metrics.remaining,
        result.metrics.total_population
    );
}

#[test]
fn speed_spread_is_seeded_and_independent_of_placement_and_modifier_edits() {
    let mut building = room();
    building.placed_occupants.clear();
    building.spawn_zones =
        serde_json::from_value(json!([{"id":"area","x":1,"y":3,"width":8,"height":5,"count":8}]))
            .unwrap();
    building.max_steps = 2;
    let legacy = simulate(&building).unwrap();
    building.agent_speed_variation = Some(0.05);
    let first = simulate(&building).unwrap();
    let second = simulate(&building).unwrap();
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(&second).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&legacy.frames[0]).unwrap(),
        serde_json::to_value(&first.frames[0]).unwrap()
    );
    let speeds: Vec<_> = first
        .agent_modifiers
        .as_ref()
        .unwrap()
        .agents
        .iter()
        .map(|a| a.uninjured_speed_metres_per_second)
        .collect();
    assert!(speeds.iter().all(|s| (1.235..=1.365).contains(s)));
    assert!(speeds.windows(2).any(|w| w[0] != w[1]));
    building.agent_modifiers =
        serde_json::from_value(json!([{"id":"slow","name":"Slow","speed_multiplier":0.5}]))
            .unwrap();
    building.spawn_zones[0].modifier_groups =
        serde_json::from_value(json!([{"count":8,"modifier_ids":["slow"]}])).unwrap();
    let slow = simulate(&building).unwrap();
    assert_eq!(
        serde_json::to_value(&first.frames[0]).unwrap(),
        serde_json::to_value(&slow.frames[0]).unwrap()
    );
    for (a, b) in first
        .agent_modifiers
        .unwrap()
        .agents
        .iter()
        .zip(&slow.agent_modifiers.as_ref().unwrap().agents)
    {
        assert_eq!(a.speed_variation_multiplier, b.speed_variation_multiplier);
    }
    check_caps(&building, &slow);
}

#[test]
fn neutral_assignments_preserve_legacy_output_except_metadata() {
    let plain = simulate(&room()).unwrap();
    let neutral = simulate(&modified(
        json!([{"id":"neutral","name":"Neutral"}]),
        json!(["neutral"]),
    ))
    .unwrap();
    let mut plain = serde_json::to_value(plain).unwrap();
    let mut neutral = serde_json::to_value(neutral).unwrap();
    plain.as_object_mut().unwrap().remove("agent_modifiers");
    neutral.as_object_mut().unwrap().remove("agent_modifiers");
    assert_eq!(plain, neutral);
}

#[test]
fn composition_and_zone_groups_are_order_independent_with_caps_applied_once() {
    let mut building = modified(
        json!([
            {"id":"a","name":"A","speed_multiplier":2,"reaction_delay_seconds":20},
            {"id":"b","name":"B","speed_multiplier":2,"reaction_delay_seconds":20},
            {"id":"c","name":"C","speed_multiplier":0.5}
        ]),
        json!(["b", "c", "a"]),
    );
    building.spawn_zones = serde_json::from_value(json!([{"id":"zone","x":1,"y":2,"width":8,"height":3,"count":6,"modifier_groups":[{"count":2,"modifier_ids":["a","c"]},{"count":2,"modifier_ids":[]},{"count":2,"modifier_ids":["c","a"]}]}])).unwrap();
    building.max_steps = 1;
    let first = simulate(&building).unwrap();
    let assignments = &first.agent_modifiers.as_ref().unwrap().agents;
    assert_eq!(assignments[0].resolved.speed_multiplier, 2.0);
    assert_eq!(assignments[0].resolved.reaction_delay_seconds, 30.0);
    assert_eq!(
        assignments
            .iter()
            .filter(|a| a.modifier_ids == ["a", "c"])
            .count(),
        4
    );
    building.agent_modifiers.reverse();
    building.placed_occupants[0].modifier_ids.reverse();
    building.spawn_zones[0]
        .modifier_groups
        .as_mut()
        .unwrap()
        .reverse();
    let second = simulate(&building).unwrap();
    assert_eq!(
        serde_json::to_value(&first.agent_modifiers.unwrap().agents).unwrap(),
        serde_json::to_value(&second.agent_modifiers.unwrap().agents).unwrap()
    );
}

#[test]
fn reaction_wait_is_not_collision_wait_and_slow_agents_still_finish() {
    let building = modified(
        json!([{"id":"scared","name":"Scared","speed_multiplier":0.1,"reaction_delay_seconds":20}]),
        json!(["scared"]),
    );
    let result = simulate(&building).unwrap();
    check_caps(&building, &result);
    assert_eq!(result.metrics.evacuated, 1);
    for frame in result.frames.iter().take_while(|f| f.step <= 200) {
        assert_eq!((frame.agents[0].x, frame.agents[0].y), (5.0, 7.0));
    }
    assert!(result.analytics.as_ref().unwrap().agents[0].waiting_steps < 200);
    let mut timeout = building;
    timeout.max_steps = 10;
    let result = simulate(&timeout).unwrap();
    assert_eq!(result.frames.last().unwrap().step, 10);
    assert_eq!(result.metrics.remaining, 1);
    assert_eq!(result.metrics.trapped, 0);
    assert!(result.metrics.clearance_steps.is_none());
    assert_eq!(result.analytics.unwrap().agents[0].waiting_steps, 0);
}

#[test]
fn normal_and_live_share_the_same_modifiers_and_real_frames() {
    let mut building = modified(
        json!([{"id":"slow","name":"Slow","speed_multiplier":0.5,"acceleration_multiplier":0.4,"reaction_delay_seconds":2}]),
        json!(["slow"]),
    );
    building.agent_speed_variation = Some(0.05);
    let saved = simulate(&building).unwrap();
    let mut streamed = Vec::new();
    let live = simulate_live(&building, &mut |f| {
        streamed.push(f.clone());
        true
    })
    .unwrap();
    assert_eq!(
        serde_json::to_value(&saved).unwrap(),
        serde_json::to_value(&live).unwrap()
    );
    assert_eq!(
        serde_json::to_value(streamed.last()).unwrap(),
        serde_json::to_value(saved.frames.last()).unwrap()
    );
    check_caps(&building, &saved);
}

#[test]
fn invalid_modifier_values_references_and_groups_fail_clearly() {
    for (definitions, references) in [
        (
            json!([{"id":"slow","name":"Slow","speed_multiplier":0}]),
            json!(["slow"]),
        ),
        (
            json!([{"id":"slow","name":"Slow","reaction_delay_seconds":31}]),
            json!(["slow"]),
        ),
        (json!([{"id":"slow","name":"Slow"}]), json!(["missing"])),
        (
            json!([{"id":"slow","name":"Slow"}]),
            json!(["slow", "slow"]),
        ),
        (
            json!([{"id":"slow","name":"Slow"},{"id":"slow","name":"Duplicate"}]),
            json!([]),
        ),
    ] {
        assert!(simulate(&modified(definitions, references)).is_err());
    }
    let mut building = room();
    building.spawn_zones = serde_json::from_value(json!([{"id":"area","x":1,"y":3,"width":4,"height":3,"count":2,"modifier_groups":[{"count":1,"modifier_ids":[]}]}])).unwrap();
    assert!(building.validate().unwrap_err().contains("sum"));
    building.spawn_zones.clear();
    building.agent_speed_variation = Some(f64::NAN);
    assert!(building.validate().is_err());
    let mut value = serde_json::to_value(room()).unwrap();
    value["agent_modifiers"] = json!([{"id":"bad","name":"Bad","push_through_walls":true}]);
    assert!(serde_json::from_value::<BuildingScenario>(value).is_err());
}

#[test]
fn pursuit_rejects_non_neutral_assignments() {
    let mut value: Value = serde_json::from_str(include_str!(
        "../../frontend/src/editor/presets/halloween-pursuit.json"
    ))
    .unwrap();
    value["agent_modifiers"] = json!([{"id":"slow","name":"Slow","speed_multiplier":0.5}]);
    let count = value["spawn_zones"][0]["count"].clone();
    value["spawn_zones"][0]["modifier_groups"] = json!([{"count":count,"modifier_ids":["slow"]}]);
    let building: BuildingScenario = serde_json::from_value(value).unwrap();
    assert!(building.validate().unwrap_err().contains("Pursuit"));
}

#[test]
fn aggressive_priority_changes_yielding_without_overlapping_bodies() {
    let mut building = room();
    building.exits[0].offset = 4.675;
    building.exits[0].width = 0.65;
    building.placed_occupants = serde_json::from_value(json!([
        {"id":"left","x":4,"y":3},{"id":"right","x":6,"y":3}
    ]))
    .unwrap();
    let neutral = simulate(&building).unwrap();
    building.agent_modifiers = serde_json::from_value(
        json!([{"id":"assertive","name":"Aggressive","avoidance_priority_multiplier":4}]),
    )
    .unwrap();
    building.placed_occupants[1].modifier_ids = vec!["assertive".into()];
    let assertive = simulate(&building).unwrap();
    check_caps(&building, &assertive);
    assert_eq!(assertive.metrics.evacuated, 2);
    let first = |r: &SimulationResult| {
        r.analytics
            .as_ref()
            .unwrap()
            .agents
            .iter()
            .min_by_key(|a| a.evacuation_step)
            .unwrap()
            .id
    };
    assert_eq!(first(&neutral), 0);
    assert_eq!(first(&assertive), 1);
    for frame in &assertive.frames {
        for (i, a) in frame.agents.iter().enumerate() {
            for b in &frame.agents[..i] {
                assert!((a.x - b.x).hypot(a.y - b.y) >= 2.0 * building.agent_radius - 1e-8);
            }
        }
    }
}

#[test]
fn mixed_fixture_assignments_survive_closures_and_recordings_reject_invalid_metadata() {
    let mut building: BuildingScenario =
        serde_json::from_str(include_str!("../../shared/examples/agent-modifiers.json")).unwrap();
    building.max_steps = 1;
    let original = simulate(&building).unwrap();
    building.blocked_exit_ids.push("west".into());
    let closure = simulate(&building).unwrap();
    assert_eq!(
        serde_json::to_value(&original.agent_modifiers).unwrap(),
        serde_json::to_value(&closure.agent_modifiers).unwrap()
    );
    for (a, b) in original.frames[0]
        .agents
        .iter()
        .zip(&closure.frames[0].agents)
    {
        assert_eq!((a.id, a.x, a.y), (b.id, b.x, b.y));
    }
    let mut broken = original.clone();
    broken.agent_modifiers.as_mut().unwrap().agents[0].uninjured_speed_metres_per_second = 100.0;
    assert!(broken.validate().is_err());
    let mut broken = original;
    broken.agent_modifiers.as_mut().unwrap().agents[0].modifier_ids = vec!["unknown".into()];
    assert!(broken.validate().is_err());
}

#[test]
fn reaction_and_free_flow_at_a_lower_preferred_speed_are_not_crowd_delay() {
    let mut building = modified(
        json!([{"id":"slow","name":"Slow","speed_multiplier":0.2,"reaction_delay_seconds":2}]),
        json!(["slow"]),
    );
    building.exits[0].offset = 2.0;
    building.exits[0].width = 6.0;
    building.placed_occupants = serde_json::from_value(json!([
        {"id":"left","x":4.6,"y":7,"modifier_ids":["slow"]},
        {"id":"right","x":5.4,"y":7,"modifier_ids":["slow"]}
    ]))
    .unwrap();
    building.max_steps = 40;
    let result = simulate(&building).unwrap();
    check_caps(&building, &result);
    let early: f64 = result
        .frames
        .iter()
        .filter(|f| f.step <= 20)
        .flat_map(|f| f.congestion_samples.iter().flatten())
        .map(|s| s.crowd_delay_seconds)
        .sum();
    assert_eq!(early, 0.0);
    let cruising: f64 = result
        .frames
        .iter()
        .filter(|f| f.step > 30)
        .flat_map(|f| f.congestion_samples.iter().flatten())
        .map(|s| s.crowd_delay_seconds)
        .sum();
    assert_eq!(cruising, 0.0);
}

#[test]
fn reduced_mobility_obeys_its_cap_during_real_window_traversal() {
    let mut building: BuildingScenario =
        serde_json::from_str(include_str!("../../shared/examples/window-escape.json")).unwrap();
    building.agent_modifiers = serde_json::from_value(
        json!([{"id":"slow","name":"Slow","speed_multiplier":0.2,"reaction_delay_seconds":1}]),
    )
    .unwrap();
    building.agent_speed_variation = Some(0.05);
    building.blocked_exit_ids = building.exits.iter().map(|exit| exit.id.clone()).collect();
    for zone in &mut building.spawn_zones {
        zone.count = 1;
        zone.modifier_groups =
            serde_json::from_value(json!([{"count":1,"modifier_ids":["slow"]}])).unwrap();
    }
    building.max_steps = 2000;
    let result = simulate(&building).unwrap();
    check_caps(&building, &result);
    assert!(
        result
            .metrics
            .evacuated_by_route
            .as_ref()
            .unwrap()
            .emergency_window
            > 0
    );
}

#[test]
fn curious_requires_personal_discovery_but_basic_evacuation_is_unchanged() {
    let mut building = modified(
        json!([{"id":"curious","name":"Curious","requires_emergency_discovery":true}]),
        json!(["curious"]),
    );
    let ordinary = simulate(&building).unwrap();
    assert_eq!(ordinary.metrics.evacuated, 1);
    building.disaster =
        serde_json::from_value(json!({"kind":"gas_leak","center":{"x":8,"y":7},"radius":0.3}))
            .unwrap();
    let visible = simulate(&building).unwrap();
    assert_eq!(visible.metrics.evacuated, 1);
    building.awareness.sight_range_metres = 0.0;
    building.max_steps = 30;
    let unseen = simulate(&building).unwrap();
    assert_eq!(unseen.metrics.evacuated, 0);
    assert_eq!(unseen.metrics.remaining, 1);
    assert_eq!(unseen.frames.last().unwrap().step, 30);
    assert_eq!(unseen.metrics.trapped, 0);
}

#[test]
fn zero_personality_fraction_makes_automatic_spawns_neutral() {
    let mut building = modified(
        json!([{"id":"slow","name":"Slow","speed_multiplier":0.5}]),
        json!([]),
    );
    building.spawn_modifier_ids = Some(vec!["slow".into()]);
    building.personality_fraction = Some(0.0);
    let result = simulate(&building).unwrap();
    assert!(
        result.agent_modifiers.unwrap().agents[0]
            .modifier_ids
            .is_empty()
    );
}

#[test]
fn curious_explores_an_occluded_room_before_evacuating() {
    let mut b = modified(
        json!([{"id":"curious","name":"Curious","requires_emergency_discovery":true}]),
        json!(["curious"]),
    );
    b.placed_occupants[0].x = 3.0;
    b.walls.extend(
        serde_json::from_value::<Vec<exitzero::models::Wall>>(json!([
            {"id":"east","start":{"x":10,"y":0},"end":{"x":10,"y":10},"thickness":0.2},
            {"id":"south","start":{"x":10,"y":10},"end":{"x":0,"y":10},"thickness":0.2},
            {"id":"west","start":{"x":0,"y":10},"end":{"x":0,"y":0},"thickness":0.2},
            {"id":"partition","start":{"x":6,"y":0},"end":{"x":6,"y":10},"thickness":0.2}
        ]))
        .unwrap(),
    );
    b.exits[0].offset = 2.0;
    b.doors = serde_json::from_value(
        json!([{"id":"passage","wall_id":"partition","offset":4,"width":1.4}]),
    )
    .unwrap();
    b.disaster =
        serde_json::from_value(json!({"kind":"gas_leak","center":{"x":8,"y":7},"radius":0.3}))
            .unwrap();
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert!(
        result
            .frames
            .iter()
            .flat_map(|f| &f.agents)
            .any(|a| a.x > 5.0),
        "must explore toward new views instead of immediately leaving through the nearby exit"
    );
    assert_eq!(result.metrics.evacuated, 1);
}
