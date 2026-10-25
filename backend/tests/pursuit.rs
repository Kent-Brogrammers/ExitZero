use exitzero::{
    models::{BuildingScenario, SimulationStatus},
    simulation::{simulate, simulate_live},
};

fn house() -> BuildingScenario {
    serde_json::from_str(include_str!(
        "../../frontend/src/editor/presets/halloween-pursuit.json"
    ))
    .unwrap()
}

#[test]
fn real_recording_contains_first_sighting_grouped_warning_and_later_relay() {
    let mut b: BuildingScenario = serde_json::from_value(serde_json::json!({
        "width":8,"height":6,"walls":[{"id":"east","start":{"x":8,"y":0},"end":{"x":8,"y":6},"thickness":0.1}],
        "doors":[],"exits":[{"id":"out","wall_id":"east","offset":0.4,"width":4}],
        "spawn_zones":[],"obstructions":[],"blocked_exit_ids":[],"seed":31,"agent_radius":0.2,"time_step_seconds":0.1,"max_steps":30,
        "awareness":{"sight_range_metres":1.1,"communication_range_metres":2.25},
        "pursuit":{"stalker_start":{"x":0.1,"y":1},"stalker_speed":0.1,"survivor_speed":1.3,"capture_radius":0.45,"avoidance_radius":2}
    })).unwrap();
    for (i, (x, y)) in [(1.0, 1.0), (2.8, 1.0), (3.0, 1.8), (5.0, 1.0)]
        .into_iter()
        .enumerate()
    {
        b.spawn_zones.push(serde_json::from_value(serde_json::json!({"id":format!("person{i}"),"x":x-0.2,"y":y-0.2,"width":0.4,"height":0.4,"count":1})).unwrap());
    }
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    let events = result
        .frames
        .last()
        .unwrap()
        .pursuit
        .as_ref()
        .unwrap()
        .events
        .as_ref()
        .unwrap();
    assert_eq!(events[0].sender_id, 0);
    assert_eq!(events[0].step, 0);
    assert_eq!(events[1].recipient_ids, vec![1, 2]);
    assert_eq!(events[1].step, 0);
    assert_eq!(events[2].sender_id, 1);
    assert_eq!(events[2].recipient_ids, vec![3]);
    assert_eq!(events[2].step, 1);
    assert_eq!(events.len(), 3, "location refreshes do not spam recordings");
}

#[test]
fn pursuit_contract_roundtrips_and_rejects_invalid_optional_values_and_capture_records() {
    let building = house();
    let json = serde_json::to_value(&building).unwrap();
    assert_eq!(
        serde_json::to_value(serde_json::from_value::<BuildingScenario>(json.clone()).unwrap())
            .unwrap(),
        json
    );
    let mut null = json;
    null["pursuit"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<BuildingScenario>(null).is_err());
    for speed in [-1.0, 0.0, 3.1, f64::NAN] {
        let mut invalid = building.clone();
        invalid.pursuit.as_mut().unwrap().stalker_speed = speed;
        assert!(invalid.validate().is_err());
    }
    let mut mixed = building.clone();
    mixed.disaster = Some(
        serde_json::from_value(
            serde_json::json!({"kind":"fire","center":{"x":1,"y":1},"radius":1}),
        )
        .unwrap(),
    );
    assert!(mixed.validate().is_err());
    let mut short = building;
    short.max_steps = 2;
    let mut result = simulate(&short).unwrap();
    let final_frame = result.frames.last_mut().unwrap();
    final_frame
        .pursuit
        .as_mut()
        .unwrap()
        .caught
        .push(exitzero::models::CaughtAgent {
            agent_id: 0,
            step: 100,
            position: None,
        });
    assert!(result.validate().is_err());
}

#[test]
fn haunted_house_runs_real_seeded_pursuit_and_preserves_survivor_accounting() {
    let building = house();
    building.validate().unwrap();
    let result = simulate(&building).unwrap();
    result.validate().unwrap();
    let end = result.frames.last().unwrap();
    let pursuit = end.pursuit.as_ref().unwrap();
    println!(
        "Haunted house: escaped={}, caught={}, active={}, seconds={}",
        pursuit.escaped,
        pursuit.caught.len(),
        end.agents.len(),
        f64::from(end.step) * result.time_step_seconds
    );
    assert!(pursuit.escaped > 0, "the scenario must be winnable");
    let routes = result.metrics.evacuated_by_route.as_ref().unwrap();
    println!(
        "Escape routes: normal={}, windows={}",
        routes.normal_exit, routes.emergency_window
    );
    assert!(routes.normal_exit > 0, "normal routes must remain usable");
    assert_eq!(
        routes.emergency_window, 3,
        "the two bedroom survivors and garage survivor need real window service"
    );
    for pane in building
        .windows
        .iter()
        .filter(|w| w.emergency_escape.as_ref().is_some_and(|e| e.enabled))
    {
        let prepared = result
            .frames
            .iter()
            .find(|f| {
                f.window_states
                    .as_ref()
                    .unwrap()
                    .iter()
                    .any(|s| s.window_id == pane.id && s.preparation_ready_step.is_some())
            })
            .unwrap();
        let state = prepared
            .window_states
            .as_ref()
            .unwrap()
            .iter()
            .find(|s| s.window_id == pane.id)
            .unwrap();
        assert!(
            state.preparation_ready_step.unwrap()
                >= prepared.step
                    + (pane.emergency_escape.as_ref().unwrap().preparation_seconds
                        / building.time_step_seconds)
                        .ceil() as u32
        );
        assert!(
            result.frames.iter().any(|f| f
                .window_states
                .as_ref()
                .unwrap()
                .iter()
                .any(|s| s.window_id == pane.id && s.traversing_agent_id.is_some())),
            "window escapes require actual recorded traversal"
        );
    }
    assert!(
        !pursuit.caught.is_empty(),
        "the pursuit must pose a real challenge"
    );
    assert!(
        end.agents.is_empty(),
        "the curated demo must resolve, not strand the cast"
    );
    assert_eq!(result.metrics.evacuated, pursuit.escaped);
    assert_eq!(result.metrics.remaining as usize, pursuit.caught.len());
    assert_eq!(result.metrics.status, SimulationStatus::Incomplete); // Caught is not evacuated.
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::to_value(simulate(&building).unwrap()).unwrap()
    );
    for frame in &result.frames {
        let p = frame.pursuit.as_ref().unwrap();
        assert_eq!(
            p.escaped as usize + p.caught.len() + frame.agents.len(),
            result.metrics.total_population as usize
        );
        for caught in &p.caught {
            assert!(!frame.agents.iter().any(|a| a.id == caught.agent_id));
            let position = caught
                .position
                .expect("real captures record their last position");
            let first = result
                .frames
                .iter()
                .find(|f| f.step == caught.step)
                .expect("capture ticks are retained even in sampled recordings");
            let original = first
                .pursuit
                .as_ref()
                .unwrap()
                .caught
                .iter()
                .find(|c| c.agent_id == caught.agent_id)
                .unwrap();
            assert_eq!(
                (position.x, position.y),
                (original.position.unwrap().x, original.position.unwrap().y)
            );
        }
    }
    assert!(!pursuit.events.as_ref().unwrap().is_empty());
    let mut legacy = serde_json::to_value(&result).unwrap();
    for frame in legacy["frames"].as_array_mut().unwrap() {
        frame["pursuit"].as_object_mut().unwrap().remove("events");
        for caught in frame["pursuit"]["caught"].as_array_mut().unwrap() {
            caught.as_object_mut().unwrap().remove("position");
        }
    }
    serde_json::from_value::<exitzero::models::SimulationResult>(legacy)
        .unwrap()
        .validate()
        .unwrap();
    let mut invalid = result.clone();
    invalid
        .frames
        .last_mut()
        .unwrap()
        .pursuit
        .as_mut()
        .unwrap()
        .caught[0]
        .position
        .as_mut()
        .unwrap()
        .x += 0.1;
    assert!(
        invalid.validate().is_err(),
        "caught positions cannot drift during replay"
    );
}

#[test]
fn blocked_house_rooms_cannot_escape_when_their_windows_are_disabled() {
    let mut building = house();
    for pane in &mut building.windows {
        if let Some(escape) = &mut pane.emergency_escape {
            escape.enabled = false;
        }
    }
    building.max_steps = 150;
    let result = simulate(&building).unwrap();
    assert_eq!(
        result
            .metrics
            .evacuated_by_route
            .as_ref()
            .unwrap()
            .emergency_window,
        0
    );
    // Stable spawn order: west bedroom IDs 1/2, garage ID 8.
    let end = result.frames.last().unwrap();
    for id in [1, 2, 8] {
        assert!(
            end.agents.iter().any(|a| a.id == id),
            "walls and blocked doors must not be bypassed"
        );
        assert!(
            !end.pursuit
                .as_ref()
                .unwrap()
                .caught
                .iter()
                .any(|c| c.agent_id == id),
            "the stalker cannot catch through walls"
        );
    }
}

#[test]
fn pursuit_live_frames_match_recording_and_cancel_releases_engine() {
    let mut building = house();
    building.max_steps = 12;
    let mut observed = Vec::new();
    let result = simulate_live(&building, &mut |f| {
        observed.push(serde_json::to_value(f).unwrap());
        true
    })
    .unwrap();
    assert_eq!(
        observed,
        serde_json::to_value(&result.frames)
            .unwrap()
            .as_array()
            .unwrap()
            .to_vec()
    );
    assert!(simulate_live(&building, &mut |_| false).is_err());
    let mut invalid = house();
    invalid.pursuit.as_mut().unwrap().stalker_start.x = 2.0;
    assert!(
        simulate(&invalid).is_err(),
        "stalker cannot start inside a wall"
    );
}
