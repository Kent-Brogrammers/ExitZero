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

fn gas_barrier_scenario() -> BuildingScenario {
    let mut b = scenario();
    b.blocked_exit_ids.clear();
    b.exits[0].wall_id = "west".into();
    b.exits[0].offset = 3.0;
    b.disaster = Some(exitzero::models::Disaster {
        kind: exitzero::models::DisasterKind::GasLeak,
        center: exitzero::models::Point { x: 10.0, y: 6.0 },
        radius: 2.0,
        dynamics: None,
    });
    b.spawn_zones[0].x = 14.0;
    b.spawn_zones[0].y = 5.0;
    b.spawn_zones[0].height = 2.0;
    b
}

#[test]
fn gas_cutting_off_an_open_exit_activates_window_escape() {
    let b = gas_barrier_scenario();
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert!(
        result
            .frames
            .iter()
            .all(|frame| frame.blocked_opening_ids.as_ref().unwrap().is_empty()),
        "the exit itself remains open; gas blocks the route to it"
    );
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(
        result
            .metrics
            .evacuated_by_route
            .as_ref()
            .unwrap()
            .emergency_window,
        4
    );
    assert!(
        result
            .analytics
            .as_ref()
            .unwrap()
            .agents
            .iter()
            .all(|agent| agent.injury == 0.0)
    );
}

#[test]
fn window_fallback_is_individual_when_only_one_side_of_a_gas_barrier_is_cut_off() {
    let mut b = gas_barrier_scenario();
    b.spawn_zones[0].x = 14.8;
    b.spawn_zones[0].y = 5.8;
    b.spawn_zones[0].width = 0.4;
    b.spawn_zones[0].height = 0.4;
    b.spawn_zones[0].count = 1;
    let mut left = b.spawn_zones[0].clone();
    left.id = "left".into();
    left.x = 3.8;
    b.spawn_zones.push(left);
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    let counts = result.metrics.evacuated_by_route.unwrap();
    assert_eq!(counts.emergency_window, 1);
    assert_eq!(counts.normal_exit, 1);
}

#[test]
fn a_safe_detour_around_gas_keeps_normal_exits_preferred() {
    let mut b = gas_barrier_scenario();
    b.disaster.as_mut().unwrap().radius = 0.75;
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(result.metrics.evacuated_by_route.unwrap().normal_exit, 4);
    assert!(
        result
            .frames
            .iter()
            .all(|frame| frame.window_states.as_ref().unwrap()[0].state == WindowState::Intact)
    );
}

#[test]
fn an_unseen_gas_barrier_does_not_trigger_early_window_fallback() {
    let mut b = gas_barrier_scenario();
    b.spawn_zones[0].x = 15.0;
    b.awareness.sight_range_metres = 0.0;
    b.awareness.communication_range_metres = 0.0;
    b.max_steps = 5;
    let actual = simulate(&b).unwrap();
    b.disaster = None;
    let unaware = simulate(&b).unwrap();
    for (frame, expected) in actual.frames.iter().zip(&unaware.frames) {
        assert_eq!(
            serde_json::to_value(&frame.agents).unwrap(),
            serde_json::to_value(&expected.agents).unwrap()
        );
        assert_eq!(
            frame.window_states.as_ref().unwrap()[0].state,
            WindowState::Intact
        );
    }
}

#[test]
fn growing_gas_cutting_off_a_previous_detour_switches_the_agent_to_a_window() {
    let mut b = gas_barrier_scenario();
    let gas = b.disaster.as_mut().unwrap();
    gas.radius = 0.75;
    gas.dynamics = Some(exitzero::models::DisasterDynamics {
        growth_rate: 0.8,
        max_radius: 2.0,
        max_patches: 1,
        ..Default::default()
    });
    b.spawn_zones[0].x = 16.8;
    b.spawn_zones[0].y = 5.8;
    b.spawn_zones[0].width = 0.4;
    b.spawn_zones[0].height = 0.4;
    b.spawn_zones[0].count = 1;
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(
        result.frames[0].window_states.as_ref().unwrap()[0].state,
        WindowState::Intact
    );
    assert!(
        result
            .frames
            .iter()
            .any(|frame| frame.window_states.as_ref().unwrap()[0].state == WindowState::Breaking)
    );
    assert_eq!(
        result.metrics.evacuated_by_route.unwrap().emergency_window,
        1
    );
}

#[test]
fn configured_windows_on_each_exterior_wall_can_be_reached_and_used() {
    for wall_id in ["north", "east", "south", "west"] {
        for seed in [3, 17, 42, 99] {
            let mut b = scenario();
            b.seed = seed;
            b.windows[0].wall_id = wall_id.into();
            b.windows[0].offset = 0.5;
            b.windows[0].width = 1.2;
            b.windows[0]
                .emergency_escape
                .as_mut()
                .unwrap()
                .clear_width_metres = 1.2;
            let result = simulate(&b).unwrap();
            result.validate().unwrap();
            assert_eq!(
                result.metrics.status,
                SimulationStatus::Completed,
                "wall {wall_id}, seed {seed}: {:?}",
                result.frames.last()
            );
            assert_eq!(
                result.metrics.evacuated_by_route.unwrap().emergency_window,
                4
            );
        }
    }
}

#[test]
fn saved_layout_exterior_directions_control_window_reachability() {
    let mut b: BuildingScenario =
        serde_json::from_str(include_str!("../../shared/examples/window-escape.json")).unwrap();
    // Test the supplied layout as saved, including its screened-off exit.
    // No hazard or explicit exit closure is needed to exercise discovery.
    let discovered = simulate(&b).unwrap();
    discovered.validate().unwrap();
    assert_eq!(discovered.metrics.status, SimulationStatus::Completed);
    assert_eq!(
        discovered
            .metrics
            .evacuated_by_route
            .unwrap()
            .emergency_window,
        34
    );
    b.blocked_exit_ids = b.exits.iter().map(|exit| exit.id.clone()).collect();
    let mut inward = b.clone();
    for window in &mut inward.windows {
        window.emergency_escape.as_mut().unwrap().exterior_side = 1;
    }
    let rejected = simulate(&inward).unwrap();
    rejected.validate().unwrap();
    assert_eq!(rejected.metrics.evacuated, 0);
    assert!(
        rejected.frames[0]
            .window_states
            .as_ref()
            .unwrap()
            .iter()
            .all(|window| {
                window.state == WindowState::Intact
                    && window.queue_agent_ids.is_empty()
                    && window
                        .unavailable_reason
                        .as_deref()
                        .is_some_and(|reason| reason.contains("exterior direction"))
            })
    );
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(
        result.metrics.evacuated_by_route.unwrap().emergency_window,
        34
    );
    assert!(
        result.frames[0]
            .window_states
            .as_ref()
            .unwrap()
            .iter()
            .map(|window| window.approaching_agent_ids.as_ref().unwrap().len())
            .sum::<usize>()
            > 0
    );
}

#[test]
fn corrected_saved_layout_uses_windows_when_gas_covers_its_exit() {
    let mut b: BuildingScenario =
        serde_json::from_str(include_str!("../../shared/examples/window-escape.json")).unwrap();
    let exit = &b.exits[0];
    let wall = b.walls.iter().find(|wall| wall.id == exit.wall_id).unwrap();
    let t = (exit.offset + exit.width / 2.0) / wall.length();
    b.disaster = Some(exitzero::models::Disaster {
        kind: exitzero::models::DisasterKind::GasLeak,
        center: exitzero::models::Point {
            x: wall.start.x + (wall.end.x - wall.start.x) * t,
            y: wall.start.y + (wall.end.y - wall.start.y) * t,
        },
        radius: 0.5,
        dynamics: None,
    });
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(
        result.metrics.evacuated_by_route.unwrap().emergency_window,
        34
    );
}

#[test]
fn window_readout_explains_disabled_escape_missing_context_and_out_of_bounds_landing() {
    for (change, expected) in [
        ("disabled", "disabled"),
        ("context", "Ground-floor"),
        ("landing", "Exterior landing availability"),
        ("bounds", "does not fit in the workspace"),
    ] {
        let mut b = scenario();
        match change {
            "disabled" => b.windows[0].emergency_escape.as_mut().unwrap().enabled = false,
            "context" => b.window_escape_context = None,
            "landing" => {
                b.windows[0]
                    .emergency_escape
                    .as_mut()
                    .unwrap()
                    .exterior_available = false
            }
            "bounds" => b.width = 18.0,
            _ => unreachable!(),
        }
        let result = simulate(&b).unwrap();
        result.validate().unwrap();
        assert!(
            result.frames[0].window_states.as_ref().unwrap()[0]
                .unavailable_reason
                .as_deref()
                .is_some_and(|reason| reason.contains(expected)),
            "{change}"
        );
    }
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

#[test]
fn tornado_response_uses_shelter_instead_of_breaking_windows() {
    let mut b = scenario();
    b.disaster = Some(exitzero::models::Disaster {
        kind: exitzero::models::DisasterKind::Tornado,
        center: exitzero::models::Point { x: 4.0, y: 6.0 },
        radius: 0.5,
        dynamics: None,
    });
    b.tornado_zones = vec![exitzero::models::Obstruction {
        id: "shelter".into(),
        name: None,
        x: 11.0,
        y: 3.0,
        width: 4.0,
        height: 5.0,
    }];
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(result.metrics.sheltered, 4);
    assert_eq!(result.metrics.evacuated, 0);
    assert!(result.frames.iter().all(|frame| {
        let pane = &frame.window_states.as_ref().unwrap()[0];
        pane.state == WindowState::Intact
            && pane.queue_agent_ids.is_empty()
            && pane.traversing_agent_id.is_none()
    }));
}

#[test]
fn fire_and_gas_at_the_landing_prevent_window_service() {
    for kind in [
        exitzero::models::DisasterKind::Fire,
        exitzero::models::DisasterKind::GasLeak,
    ] {
        let mut b = scenario();
        b.disaster = Some(exitzero::models::Disaster {
            kind,
            center: exitzero::models::Point { x: 18.8, y: 6.0 },
            radius: 0.5,
            dynamics: None,
        });
        let result = simulate(&b).unwrap();
        result.validate().unwrap();
        assert_eq!(result.metrics.evacuated, 0, "{kind:?}");
        assert!(result.frames.iter().all(|frame| {
            frame.window_states.as_ref().unwrap()[0].state == WindowState::Intact
        }));
    }
}

#[test]
fn growing_fire_releases_the_queue_and_reroutes_to_another_window() {
    let mut b = scenario();
    b.spawn_zones[0].x = 17.4999;
    b.spawn_zones[0].y = 5.8;
    b.spawn_zones[0].width = 0.4;
    b.spawn_zones[0].height = 0.4;
    b.spawn_zones[0].count = 1;
    let mut alternative = b.windows[0].clone();
    alternative.id = "alternative".into();
    alternative.offset = 0.5;
    alternative.width = 1.6;
    b.windows.push(alternative);
    b.disaster = Some(exitzero::models::Disaster {
        kind: exitzero::models::DisasterKind::Fire,
        center: exitzero::models::Point { x: 18.8, y: 6.0 },
        radius: 0.05,
        dynamics: Some(exitzero::models::DisasterDynamics {
            growth_rate: 0.2,
            max_patches: 1,
            max_radius: 0.6,
            ..Default::default()
        }),
    });
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(
        result.analytics.as_ref().unwrap().agents[0]
            .escape_route
            .as_ref()
            .unwrap()
            .opening_id,
        "alternative"
    );
    assert!(
        result.frames.iter().any(|frame| {
            frame.window_states.as_ref().unwrap()[0].state == WindowState::Breaking
        })
    );
    assert!(result.frames.iter().all(|frame| {
        frame.window_states.as_ref().unwrap()[0]
            .traversing_agent_id
            .is_none()
    }));
    assert!(
        result
            .frames
            .last()
            .unwrap()
            .window_states
            .as_ref()
            .unwrap()[0]
            .queue_agent_ids
            .is_empty()
    );
}

#[test]
fn a_fire_closing_the_last_normal_exit_activates_window_escape() {
    let mut b = scenario();
    b.blocked_exit_ids.clear();
    b.disaster = Some(exitzero::models::Disaster {
        kind: exitzero::models::DisasterKind::Fire,
        center: exitzero::models::Point { x: 9.0, y: 2.0 },
        radius: 0.6,
        dynamics: None,
    });
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(
        result.metrics.evacuated_by_route.unwrap().emergency_window,
        4
    );
    assert!(
        result.frames[0]
            .blocked_opening_ids
            .as_ref()
            .unwrap()
            .contains(&"exit".into())
    );
}

#[test]
fn fire_overtaking_an_active_crossing_records_exposure_without_teleporting() {
    let mut b = scenario();
    b.spawn_zones[0].x = 17.4999;
    b.spawn_zones[0].y = 5.8;
    b.spawn_zones[0].width = 0.4;
    b.spawn_zones[0].height = 0.4;
    b.spawn_zones[0].count = 1;
    b.windows[0]
        .emergency_escape
        .as_mut()
        .unwrap()
        .preparation_seconds = 0.0;
    b.disaster = Some(exitzero::models::Disaster {
        kind: exitzero::models::DisasterKind::Fire,
        center: exitzero::models::Point { x: 18.8, y: 6.0 },
        radius: 0.05,
        dynamics: Some(exitzero::models::DisasterDynamics {
            growth_rate: 2.0,
            max_patches: 1,
            max_radius: 0.6,
            ..Default::default()
        }),
    });
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    let person = &result.analytics.as_ref().unwrap().agents[0];
    assert!(person.exposure_seconds > 0.0);
    assert!(person.injury > 0.0);
    assert_eq!(
        person.escape_route.as_ref().unwrap().kind,
        EscapeRouteKind::EmergencyWindow
    );
    for frames in result.frames.windows(2) {
        let (Some(from), Some(to)) = (frames[0].agents.first(), frames[1].agents.first()) else {
            continue;
        };
        assert!((to.x - from.x).hypot(to.y - from.y) <= 1.3 * b.time_step_seconds + 1e-8);
        assert!(
            to.x >= from.x - 1e-8,
            "an active climber must not jump back indoors"
        );
    }
}

#[test]
fn injury_speed_limits_apply_during_window_approach_and_traversal() {
    let mut b = scenario();
    b.spawn_zones[0].x = 12.8;
    b.spawn_zones[0].y = 5.8;
    b.spawn_zones[0].width = 0.4;
    b.spawn_zones[0].height = 0.4;
    b.spawn_zones[0].count = 1;
    b.windows[0]
        .emergency_escape
        .as_mut()
        .unwrap()
        .traversal_seconds = 0.25;
    b.disaster = Some(exitzero::models::Disaster {
        kind: exitzero::models::DisasterKind::Fire,
        center: exitzero::models::Point { x: 13.0, y: 6.0 },
        radius: 0.4,
        dynamics: None,
    });
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert!(result.analytics.as_ref().unwrap().agents[0].injury > 0.0);
    for frames in result.frames.windows(2) {
        let (Some(from), Some(to)) = (frames[0].agents.first(), frames[1].agents.first()) else {
            continue;
        };
        let speed = 1.3 * (1.0 - 0.75 * from.injury.unwrap_or(0.0));
        let travelled = (to.x - from.x).hypot(to.y - from.y);
        assert!(travelled <= speed * b.time_step_seconds + 1e-8);
    }
}
