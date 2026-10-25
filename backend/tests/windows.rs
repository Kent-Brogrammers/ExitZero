use exitzero::{
    models::{BuildingScenario, EscapeRouteKind, SimulationStatus, WindowState},
    simulation::{simulate, simulate_live},
};
use serde_json::json;

fn scenario() -> BuildingScenario {
    serde_json::from_value(json!({
        "width":20,"height":12,
        "walls":[
            {"id":"north","start":{"x":2,"y":2},"end":{"x":18,"y":2},"thickness":0.2},
            {"id":"east","start":{"x":18,"y":2},"end":{"x":18,"y":10},"thickness":0.2},
            {"id":"south","start":{"x":18,"y":10},"end":{"x":2,"y":10},"thickness":0.2},
            {"id":"west","start":{"x":2,"y":10},"end":{"x":2,"y":2},"thickness":0.2}],
        "doors":[],"exits":[{"id":"exit","wall_id":"north","offset":6,"width":2}],
        "windows":[{"id":"window","name":"East escape window","wall_id":"east","offset":3,"width":2,
            "emergency_escape":{"enabled":true,"preparation":"break","clear_width_metres":1.6,"clear_height_metres":1.2,
                "preparation_seconds":2,"traversal_seconds":3,"exterior_side":-1,"exterior_available":true}}],
        "window_escape_context":{"floor_elevation_metres":0,"all_agents_can_traverse":true,"required_clear_height_metres":1},
        "spawn_zones":[{"id":"people","x":12,"y":4,"width":2,"height":3,"count":4}],
        "blocked_exit_ids":["exit"],"obstructions":[],"agent_radius":0.2,"time_step_seconds":0.1,"seed":42,"max_steps":1000
    })).unwrap()
}

#[test]
fn blocked_exits_use_one_shared_preparation_and_serial_collision_checked_traversals() {
    let scenario = scenario();
    let result = simulate(&scenario).unwrap();
    result.validate().unwrap();
    assert_eq!(
        result.metrics.status,
        SimulationStatus::Completed,
        "last frame: {:?}",
        result.frames.last()
    );
    assert_eq!(
        result
            .metrics
            .evacuated_by_route
            .as_ref()
            .unwrap()
            .emergency_window,
        4
    );
    let snapshots: Vec<_> = result
        .frames
        .iter()
        .map(|f| (f.step, &f.window_states.as_ref().unwrap()[0]))
        .collect();
    let ready: Vec<_> = snapshots
        .iter()
        .filter_map(|(_, s)| s.preparation_ready_step)
        .collect();
    assert!(!ready.is_empty());
    assert!(
        ready.iter().all(|r| *r == ready[0]),
        "preparation must run once"
    );
    assert!(
        snapshots
            .iter()
            .any(|(_, s)| s.state == WindowState::Breaking)
    );
    assert!(snapshots.iter().any(|(_, s)| s.queue_agent_ids.len() > 1));
    let mut exits: Vec<_> = result
        .analytics
        .as_ref()
        .unwrap()
        .agents
        .iter()
        .map(|a| {
            assert!(a.exit_id.is_none());
            assert_eq!(
                a.escape_route.as_ref().unwrap().kind,
                EscapeRouteKind::EmergencyWindow
            );
            a.evacuation_step.unwrap()
        })
        .collect();
    exits.sort();
    assert!(exits[0] >= ready[0] + 30);
    assert!(exits.windows(2).all(|p| p[1] >= p[0] + 30));
    for frame in &result.frames {
        for a in &frame.agents {
            for b in frame.agents.iter().filter(|b| b.id > a.id) {
                assert!((a.x - b.x).hypot(a.y - b.y) >= 0.4 - 1e-7);
            }
            if a.x > 18.0 - 0.3 {
                assert!(frame.window_states.as_ref().unwrap()[0].traversing_agent_id == Some(a.id));
            }
        }
    }
}

#[test]
fn normal_exits_always_win_and_ordinary_windows_remain_intact() {
    let mut scenario = scenario();
    scenario.blocked_exit_ids.clear();
    let result = simulate(&scenario).unwrap();
    result.validate().unwrap();
    assert_eq!(
        result.metrics.status,
        SimulationStatus::Completed,
        "last frame: {:?}",
        result.frames.last()
    );
    assert_eq!(
        result.metrics.evacuated_by_route.unwrap().emergency_window,
        0
    );
    assert!(
        result
            .frames
            .iter()
            .all(|f| f.window_states.as_ref().unwrap()[0].state == WindowState::Intact)
    );
}

#[test]
fn ineligible_windows_never_evict_occupants() {
    let original = serde_json::to_value(scenario()).unwrap();
    for (pointer, value) in [
        ("/windows/0/emergency_escape/enabled", json!(false)),
        (
            "/windows/0/emergency_escape/exterior_available",
            json!(false),
        ),
        ("/windows/0/emergency_escape/clear_width_metres", json!(0.2)),
        (
            "/windows/0/emergency_escape/clear_height_metres",
            json!(0.5),
        ),
        ("/windows/0/emergency_escape/exterior_side", json!(1)),
        ("/window_escape_context/floor_elevation_metres", json!(3)),
        (
            "/window_escape_context/all_agents_can_traverse",
            json!(false),
        ),
    ] {
        let mut value_scenario = original.clone();
        *value_scenario.pointer_mut(pointer).unwrap() = value;
        let scenario: BuildingScenario = serde_json::from_value(value_scenario).unwrap();
        let result = simulate(&scenario).unwrap();
        result.validate().unwrap();
        assert_eq!(result.metrics.evacuated, 0, "{pointer}");
        assert_ne!(result.metrics.status, SimulationStatus::Completed);
    }
    for field in ["window_escape_context", "windows"] {
        let mut value = original.clone();
        value.as_object_mut().unwrap().remove(field);
        let result = simulate(&serde_json::from_value(value).unwrap()).unwrap();
        assert_eq!(result.metrics.evacuated, 0);
    }
}

#[test]
fn live_window_states_match_the_recording_and_timeout_does_not_mark_queue_trapped() {
    let mut scenario = scenario();
    scenario.max_steps = 60;
    let mut live = Vec::new();
    let result = simulate_live(&scenario, &mut |f| {
        live.push(serde_json::to_value(f).unwrap());
        true
    })
    .unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Timeout);
    assert_eq!(result.metrics.trapped, 0);
    assert!(result.metrics.remaining > 0);
    for frame in &result.frames {
        assert!(live.contains(&serde_json::to_value(frame).unwrap()));
    }
}

#[test]
fn window_contract_roundtrip_and_opening_validation() {
    let value = serde_json::to_value(scenario()).unwrap();
    let roundtrip: BuildingScenario = serde_json::from_value(value.clone()).unwrap();
    roundtrip.validate().unwrap();
    assert_eq!(serde_json::to_value(roundtrip).unwrap(), value);
    for (path, invalid) in [
        ("/windows/0/offset", json!(8)),
        ("/windows/0/width", json!(0)),
        ("/windows/0/emergency_escape/clear_width_metres", json!(3)),
        ("/windows/0/emergency_escape/traversal_seconds", json!(0)),
        ("/windows/0/id", json!("exit")),
    ] {
        let mut value = value.clone();
        *value.pointer_mut(path).unwrap() = invalid;
        let b: BuildingScenario = serde_json::from_value(value).unwrap();
        assert!(b.validate().is_err(), "{path}");
    }
    let mut value = value;
    value["doors"] = json!([{"id":"door","wall_id":"east","offset":4,"width":1}]);
    assert!(
        serde_json::from_value::<BuildingScenario>(value)
            .unwrap()
            .validate()
            .is_err()
    );
}

#[test]
fn angled_windows_use_the_same_geometry_and_open_preparation_state() {
    let mut b = scenario();
    b.walls[1].end.x = 16.0;
    b.walls[2].start.x = 16.0;
    b.windows[0].emergency_escape.as_mut().unwrap().preparation =
        exitzero::models::WindowPreparation::Open;
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(
        result.metrics.status,
        SimulationStatus::Completed,
        "last frame: {:?}",
        result.frames.last()
    );
    assert!(
        result
            .frames
            .iter()
            .any(|f| f.window_states.as_ref().unwrap()[0].state == WindowState::Opening)
    );
    assert!(
        result
            .frames
            .iter()
            .any(|f| f.window_states.as_ref().unwrap()[0].state == WindowState::Open)
    );
}

#[test]
fn zero_and_fractional_preparation_use_ceil_ticks_without_global_slowdown() {
    // A 0.6002 m crossing also obeys the ordinary 1.3 m/s speed cap: five ticks.
    for (seconds, expected_ready, expected_finish) in [(0.0, 0, 5), (0.25, 3, 8)] {
        let mut b = scenario();
        b.spawn_zones[0].x = 17.4999;
        b.spawn_zones[0].y = 5.8;
        b.spawn_zones[0].width = 0.4;
        b.spawn_zones[0].height = 0.4;
        b.spawn_zones[0].count = 1;
        let config = b.windows[0].emergency_escape.as_mut().unwrap();
        config.preparation_seconds = seconds;
        config.traversal_seconds = 0.25;
        let result = simulate(&b).unwrap();
        result.validate().unwrap();
        assert_eq!(result.metrics.status, SimulationStatus::Completed);
        assert_eq!(
            result.frames[0].window_states.as_ref().unwrap()[0].preparation_ready_step,
            Some(expected_ready)
        );
        assert_eq!(result.metrics.clearance_steps, Some(expected_finish));
        assert_eq!(
            result.analytics.unwrap().agents[0].waiting_steps,
            0,
            "service time must not be misreported as collision waiting"
        );
    }
}

#[test]
fn reopening_normal_exit_releases_queued_occupants_but_finishes_an_active_crossing() {
    let mut b = scenario();
    b.opening_events.push(exitzero::models::OpeningStateChange {
        step: 70,
        opening_id: "exit".into(),
        blocked: false,
    });
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    let routes = result.metrics.evacuated_by_route.unwrap();
    assert_eq!(routes.emergency_window, 1);
    assert_eq!(routes.normal_exit, 3);
    assert!(result.frames.iter().filter(|f| f.step >= 70).all(|f| {
        f.window_states.as_ref().unwrap()[0]
            .queue_agent_ids
            .is_empty()
    }));
}

#[test]
fn a_normal_exit_reopening_during_preparation_prevents_window_traversal() {
    let mut b = scenario();
    let baseline = simulate(&b).unwrap();
    let start = baseline
        .frames
        .iter()
        .find(|f| f.window_states.as_ref().unwrap()[0].state == WindowState::Breaking)
        .unwrap()
        .step;
    b.opening_events.push(exitzero::models::OpeningStateChange {
        step: start + 1,
        opening_id: "exit".into(),
        blocked: false,
    });
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert!(
        result
            .frames
            .iter()
            .any(|f| f.window_states.as_ref().unwrap()[0].state == WindowState::Breaking)
    );
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(
        result.metrics.evacuated_by_route.unwrap().emergency_window,
        0
    );
    assert!(result.frames.iter().all(|f| {
        f.window_states.as_ref().unwrap()[0]
            .traversing_agent_id
            .is_none()
    }));
}

#[test]
fn blocked_exterior_landing_is_not_an_escape_and_ordinary_glazing_stays_solid() {
    let mut b = scenario();
    b.obstructions.push(exitzero::models::Obstruction {
        id: "outside-cabinet".into(),
        name: None,
        x: 18.4,
        y: 5.0,
        width: 1.0,
        height: 2.0,
    });
    let result = simulate(&b).unwrap();
    assert_eq!(result.metrics.evacuated, 0);
    assert_eq!(result.metrics.trapped, 4);
    b.obstructions.clear();
    b.windows[0].emergency_escape = None;
    let result = simulate(&b).unwrap();
    assert_eq!(result.metrics.evacuated, 0);
    assert!(
        result
            .frames
            .iter()
            .all(|f| f.window_states.as_ref().unwrap()[0].state == WindowState::Intact)
    );
}

#[test]
fn normal_motion_and_spawns_are_unchanged_and_stress_resets_window_state() {
    let mut b = scenario();
    b.blocked_exit_ids.clear();
    let with_windows = simulate(&b).unwrap();
    let mut legacy = b.clone();
    legacy.windows.clear();
    legacy.window_escape_context = None;
    let without = simulate(&legacy).unwrap();
    let positions = |r: &exitzero::models::SimulationResult| {
        r.frames
            .iter()
            .map(|f| (f.step, serde_json::to_value(&f.agents).unwrap()))
            .collect::<Vec<_>>()
    };
    assert_eq!(positions(&with_windows), positions(&without));
    let request = exitzero::models::StressTestRequest {
        building: b.clone(),
        config: exitzero::models::StressTestConfig {
            max_scenarios: 1,
            block_each_exit: true,
            obstruction_candidates: vec![],
        },
    };
    let stress = exitzero::stress_testing::stress_test(&request).unwrap();
    assert_eq!(
        stress.baseline.evacuated_by_route.unwrap().emergency_window,
        0
    );
    assert_eq!(
        stress.scenarios[0]
            .metrics
            .evacuated_by_route
            .as_ref()
            .unwrap()
            .emergency_window,
        4
    );
    let repeat = exitzero::stress_testing::stress_test(&request).unwrap();
    assert_eq!(
        serde_json::to_value(stress.scenarios).unwrap(),
        serde_json::to_value(repeat.scenarios).unwrap()
    );
    assert_eq!(b.windows[0].id, "window");
}

#[test]
fn larger_queue_remains_collision_safe_and_has_bounded_population_accounting() {
    let mut b = scenario();
    b.spawn_zones[0].x = 10.0;
    b.spawn_zones[0].width = 5.0;
    b.spawn_zones[0].height = 4.0;
    b.spawn_zones[0].count = 20;
    b.max_steps = 2000;
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(
        result.metrics.status,
        SimulationStatus::Completed,
        "last: {:?}",
        result.frames.last()
    );
    assert_eq!(result.metrics.evacuated, 20);
}

#[test]
fn service_deadlines_can_extend_beyond_the_recording_horizon() {
    let mut b = scenario();
    b.max_steps = 50;
    b.windows[0]
        .emergency_escape
        .as_mut()
        .unwrap()
        .preparation_seconds = 100000.0;
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Timeout);
    assert!(
        result
            .frames
            .last()
            .unwrap()
            .window_states
            .as_ref()
            .unwrap()[0]
            .preparation_ready_step
            .unwrap()
            > 100000
    );
}
