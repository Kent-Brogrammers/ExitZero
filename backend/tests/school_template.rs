//! Run the actual editable school preset through the production engine.
use exitzero::{
    models::{
        BuildingScenario, Disaster, DisasterKind, EscapeRouteKind, Point, SimulationResult,
        SimulationStatus, WindowState,
    },
    simulation::simulate,
};
use std::collections::BTreeSet;

fn school() -> BuildingScenario {
    let building: BuildingScenario = serde_json::from_str(include_str!(
        "../../frontend/src/editor/presets/school-emergency.json"
    ))
    .unwrap();
    building.validate().unwrap();
    assert!(building.blocked_exit_ids.is_empty());
    assert!(building.opening_events.is_empty());
    building
}

fn run(building: &BuildingScenario) -> SimulationResult {
    let result = simulate(building).unwrap();
    result.validate().unwrap();
    // Furniture affects collision; the openings themselves remain open.
    assert!(
        result
            .frames
            .iter()
            .all(|f| f.blocked_opening_ids.as_ref().unwrap().is_empty())
    );
    result
}

fn classroom_a_ids(result: &SimulationResult) -> BTreeSet<u32> {
    let ids: BTreeSet<_> = result.frames[0]
        .agents
        .iter()
        .filter(|a| a.x > 2.0 && a.x < 14.0 && a.y > 2.0 && a.y < 11.0)
        .map(|a| a.id)
        .collect();
    assert_eq!(
        ids.len(),
        9,
        "eight students and one teacher in classroom A"
    );
    ids
}

#[test]
fn school_furniture_triggers_the_cut_off_classrooms_window_with_real_delays() {
    let building = school();
    let result = run(&building);
    let cut_off = classroom_a_ids(&result);
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(result.metrics.total_population, 41);
    let counts = result.metrics.evacuated_by_route.as_ref().unwrap();
    assert!(counts.emergency_window >= 9);
    assert_eq!(counts.normal_exit + counts.emergency_window, 41);
    let mut departures = Vec::new();
    for agent in &result.analytics.as_ref().unwrap().agents {
        let route = agent.escape_route.as_ref().unwrap();
        if cut_off.contains(&agent.id) {
            assert_eq!(route.kind, EscapeRouteKind::EmergencyWindow);
            assert_eq!(route.opening_id, "school-a-window");
            assert!(agent.exit_id.is_none());
            departures.push(agent.evacuation_step.unwrap());
        } else if route.kind == EscapeRouteKind::NormalExit {
            assert!(building.exits.iter().any(|e| e.id == route.opening_id));
        } else {
            assert_ne!(route.opening_id, "school-a-window");
            assert!(building.windows.iter().any(|w| w.id == route.opening_id));
        }
    }
    let snapshots: Vec<_> = result
        .frames
        .iter()
        .map(|f| {
            (
                f.step,
                f.window_states
                    .as_ref()
                    .unwrap()
                    .iter()
                    .find(|w| w.window_id == "school-a-window")
                    .unwrap(),
            )
        })
        .collect();
    let (start, opening) = snapshots
        .iter()
        .find(|(_, w)| w.state == WindowState::Opening)
        .unwrap();
    let ready = opening.preparation_ready_step.unwrap();
    let timing = building.windows[0].emergency_escape.as_ref().unwrap();
    let preparation_ticks = (timing.preparation_seconds / building.time_step_seconds).ceil() as u32;
    let traversal_ticks = (timing.traversal_seconds / building.time_step_seconds).ceil() as u32;
    assert_eq!(ready, start + preparation_ticks);
    assert!(
        snapshots
            .iter()
            .filter_map(|(_, w)| w.preparation_ready_step)
            .all(|step| step == ready)
    );
    departures.sort();
    assert!(departures[0] >= ready + traversal_ticks);
    assert!(
        departures
            .windows(2)
            .all(|pair| pair[1] >= pair[0] + traversal_ticks)
    );
    for agent in result
        .analytics
        .as_ref()
        .unwrap()
        .agents
        .iter()
        .filter(|a| cut_off.contains(&a.id))
    {
        let (step, state) = snapshots
            .iter()
            .find(|(_, w)| w.traversing_agent_id == Some(agent.id))
            .unwrap();
        assert!(*step >= ready);
        assert!(agent.evacuation_step.unwrap() >= state.traversal_earliest_finish_step.unwrap());
    }
    for window in &building.windows {
        if result.frames.iter().any(|frame| {
            frame
                .window_states
                .as_ref()
                .unwrap()
                .iter()
                .any(|state| state.window_id == window.id && state.state != WindowState::Intact)
        }) {
            assert!(
                result
                    .analytics
                    .as_ref()
                    .unwrap()
                    .agents
                    .iter()
                    .any(|agent| agent
                        .escape_route
                        .as_ref()
                        .is_some_and(|route| route.opening_id == window.id))
            );
        }
    }
}

#[test]
fn removing_the_school_door_side_cabinets_restores_normal_exit_access_for_the_classroom() {
    let mut building = school();
    building
        .obstructions
        .retain(|o| !o.id.starts_with("school-a-door-cabinet-"));
    let result = run(&building);
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    let restored = classroom_a_ids(&result);
    let counts = result.metrics.evacuated_by_route.as_ref().unwrap();
    assert_eq!(counts.normal_exit + counts.emergency_window, 41);
    assert!(
        result
            .analytics
            .as_ref()
            .unwrap()
            .agents
            .iter()
            .filter(|a| restored.contains(&a.id))
            .any(|a| a.escape_route.as_ref().unwrap().kind == EscapeRouteKind::NormalExit)
    );
    // Access is restored; individual occupants can still prefer a faster window.
}

#[test]
fn disabling_the_cut_off_classrooms_window_never_creates_an_impossible_escape() {
    let mut building = school();
    building.windows[0]
        .emergency_escape
        .as_mut()
        .unwrap()
        .enabled = false;
    let result = run(&building);
    let cut_off = classroom_a_ids(&result);
    assert_eq!(result.metrics.status, SimulationStatus::Incomplete);
    assert_eq!(result.metrics.evacuated, 32);
    assert_eq!(result.metrics.remaining, 9);
    let counts = result.metrics.evacuated_by_route.as_ref().unwrap();
    assert_eq!(counts.normal_exit + counts.emergency_window, 32);
    for agent in &result.analytics.as_ref().unwrap().agents {
        if cut_off.contains(&agent.id) {
            assert!(agent.escape_route.is_none());
            assert!(agent.evacuation_step.is_none());
        } else {
            assert_ne!(
                agent.escape_route.as_ref().unwrap().opening_id,
                "school-a-window"
            );
        }
    }
    for frame in &result.frames {
        for agent in frame.agents.iter().filter(|a| cut_off.contains(&a.id)) {
            assert!(agent.x > 2.0 && agent.x < 14.0 && agent.y > 2.0 && agent.y < 11.0);
        }
    }
    assert!(result.frames.iter().all(|f| {
        f.window_states
            .as_ref()
            .unwrap()
            .iter()
            .filter(|w| w.window_id == "school-a-window")
            .all(|w| w.state == WindowState::Intact)
    }));
}

#[test]
fn school_tornado_shelters_everyone_indoors_including_the_furniture_cut_off_classroom() {
    let mut building = school();
    building.disaster = Some(Disaster {
        kind: DisasterKind::Tornado,
        center: Point { x: 1.0, y: 13.0 },
        radius: 0.4,
        dynamics: None,
    });
    let result = run(&building);
    let cut_off = classroom_a_ids(&result);
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(result.metrics.sheltered, 41);
    assert_eq!(result.metrics.evacuated, 0);
    assert_eq!(result.metrics.remaining, 0);
    for agent in &result.analytics.as_ref().unwrap().agents {
        assert!(agent.escape_route.is_none());
        let shelter = agent.shelter.as_ref().unwrap();
        assert_eq!(
            shelter.id,
            if cut_off.contains(&agent.id) {
                "school-a-refuge"
            } else {
                "school-hall-shelter"
            }
        );
    }
    assert!(
        result.frames.iter().all(|f| f
            .window_states
            .as_ref()
            .unwrap()
            .iter()
            .all(|w| w.state == WindowState::Intact
                && w.queue_agent_ids.is_empty()
                && w.traversing_agent_id.is_none()))
    );
}
