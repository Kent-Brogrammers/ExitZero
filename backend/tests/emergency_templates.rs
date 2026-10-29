//! The gallery's editable inputs must exercise the production engine, not fixtures of results.
use exitzero::{
    models::{
        BuildingScenario, EscapeRouteKind, Point, SimulationResult, SimulationStatus,
        TerminationReason,
    },
    simulation::simulate,
};
use std::collections::BTreeSet;

const FIRE: &str = include_str!("../../frontend/src/editor/presets/office-fire.json");
const TORNADO: &str = include_str!("../../frontend/src/editor/presets/community-tornado.json");
const GAS: &str = include_str!("../../frontend/src/editor/presets/laboratory-gas.json");
const SCHOOL: &str = include_str!("../../frontend/src/editor/presets/school-emergency.json");
const CORPORATE: &str = include_str!("../../frontend/src/editor/presets/corporate-office.json");

fn building(json: &str) -> BuildingScenario {
    let b: BuildingScenario = serde_json::from_str(json).unwrap();
    b.validate().unwrap();
    assert!(b.blocked_exit_ids.is_empty());
    assert!(b.opening_events.is_empty());
    b
}

fn run(b: &BuildingScenario) -> SimulationResult {
    let result = simulate(b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(result.metrics.remaining, 0);
    result
}

#[test]
fn office_fire_redirects_evacuations_with_bounded_spread() {
    let b = building(FIRE);
    let fire = simulate(&b).unwrap();
    fire.validate().unwrap();
    let clear = building(CORPORATE);
    let mut matching = b.clone();
    matching.disaster = None;
    assert_eq!(
        serde_json::to_value(matching).unwrap(),
        serde_json::to_value(&clear).unwrap()
    );
    let baseline = run(&clear);
    assert_eq!(fire.metrics.status, SimulationStatus::Completed);
    assert!(matches!(
        fire.termination_reason,
        Some(TerminationReason::Completed)
    ));
    assert_eq!(fire.metrics.evacuated, 44);
    assert_eq!(fire.metrics.remaining, 0);
    assert_eq!(fire.metrics.trapped, 0);
    assert!(fire.metrics.clearance_steps.is_some());
    // Bounded patches close the east exit while leaving the alternate routes usable.
    let final_frame = fire.frames.last().unwrap();
    assert!(final_frame.agents.is_empty());
    assert_eq!(baseline.metrics.evacuated, 44);
    let baseline_exits: BTreeSet<_> = baseline
        .analytics
        .as_ref()
        .unwrap()
        .agents
        .iter()
        .filter_map(|a| a.exit_id.as_ref())
        .collect();
    assert_eq!(
        baseline_exits.len(),
        3,
        "the corporate plan must use all three connected exits"
    );
    assert_eq!(
        baseline
            .metrics
            .evacuated_by_route
            .as_ref()
            .unwrap()
            .emergency_window,
        0
    );
    assert!(
        fire.frames[0]
            .blocked_opening_ids
            .as_ref()
            .unwrap()
            .is_empty()
    );
    assert!(
        fire.frames.iter().any(|f| f
            .blocked_opening_ids
            .as_ref()
            .unwrap()
            .iter()
            .any(|id| id == "corp-exit-east")),
        "east exit must become unavailable during the run, not start blocked"
    );
    assert_growth(&fire);
    assert!(
        fire.frames
            .iter()
            .any(|frame| frame.disaster_state.as_ref().unwrap().areas.len() > 1),
        "fire must ignite additional patches"
    );
    let baseline_people = &baseline.analytics.as_ref().unwrap().agents;
    let redirected: BTreeSet<_> = baseline_people
        .iter()
        .filter(|a| a.exit_id.as_deref() == Some("corp-exit-east"))
        .map(|a| a.id)
        .collect();
    assert!(
        !redirected.is_empty(),
        "the no-fire baseline must actually use the east exit"
    );
    assert!(
        baseline.frames[0]
            .blocked_opening_ids
            .as_ref()
            .unwrap()
            .is_empty()
    );
    let people = &fire.analytics.as_ref().unwrap().agents;
    assert_eq!(people.len(), 44);
    assert!(people.iter().all(|a| a.evacuation_step.is_some()
        && matches!(
            a.exit_id.as_deref(),
            Some("corp-exit-west" | "corp-exit-front")
        )));
    assert!(
        people
            .iter()
            .filter(|a| redirected.contains(&a.id))
            .all(|a| a.exit_id
                != baseline_people
                    .iter()
                    .find(|old| old.id == a.id)
                    .unwrap()
                    .exit_id)
    );
}

#[test]
fn community_center_tornado_uses_both_indoor_refuges_instead_of_exterior_exits() {
    let b = building(TORNADO);
    let result = run(&b);
    assert_eq!(result.metrics.sheltered, 48);
    assert_eq!(result.metrics.evacuated, 0);
    let people = &result.analytics.as_ref().unwrap().agents;
    let mut used = BTreeSet::new();
    for agent in people {
        let shelter = agent.shelter.as_ref().unwrap();
        assert!(b.tornado_zones.iter().any(|s| s.id == shelter.id));
        assert!(agent.exit_id.is_none());
        assert!(agent.evacuation_step.is_none());
        assert!(agent.escape_route.is_none());
        used.insert(&shelter.id);
    }
    assert_eq!(used.len(), 2);
    assert_eq!(result.frames.last().unwrap().sheltered, Some(48));
    let initial = result.frames[0].disaster_state.as_ref().unwrap().areas[0].center;
    assert!(
        result.frames.iter().any(|f| {
            let center = f.disaster_state.as_ref().unwrap().areas[0].center;
            (center.x - initial.x).hypot(center.y - initial.y) > 2.0
        }),
        "the tornado footprint must actually move"
    );
    let clearance = b.disaster.unwrap().exposure_radius()
        + b.agent_radius
        + b.disaster.unwrap().dynamics.unwrap().shelter_clearance;
    for frame in &result.frames {
        let center = frame.disaster_state.as_ref().unwrap().areas[0].center;
        for zone in &b.tornado_zones {
            let nearest = Point {
                x: center.x.clamp(zone.x, zone.x + zone.width),
                y: center.y.clamp(zone.y, zone.y + zone.height),
            };
            assert!(
                (center.x - nearest.x).hypot(center.y - nearest.y) > clearance,
                "moving tornado must preserve the engine's shelter clearance"
            );
        }
    }
}

fn assert_growth(result: &SimulationResult) {
    let initial = &result.frames[0].disaster_state.as_ref().unwrap().areas;
    assert!(
        result.frames.iter().any(|f| {
            let areas = &f.disaster_state.as_ref().unwrap().areas;
            areas[0].radius > initial[0].radius
        }),
        "actual frames must record hazard growth"
    );
}

fn crossing_height(result: &SimulationResult, id: u32, x: f64) -> f64 {
    result
        .frames
        .windows(2)
        .find_map(|pair| {
            let a = pair[0].agents.iter().find(|a| a.id == id)?;
            let b = pair[1].agents.iter().find(|a| a.id == id)?;
            (a.x < x && b.x >= x).then(|| a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x))
        })
        .expect("occupant must actually cross between the west and east corridors")
}

#[test]
fn laboratory_gas_redirects_west_foyer_occupants_to_the_safe_lower_corridor() {
    let b = building(GAS);
    let gas = run(&b);
    let mut clear = b.clone();
    clear.disaster = None;
    let baseline = run(&clear);
    assert_eq!(gas.metrics.evacuated, 34);
    assert_growth(&gas);
    let source = b.disaster.unwrap();
    assert!(
        gas.frames.iter().all(|frame| {
            let areas = &frame.disaster_state.as_ref().unwrap().areas;
            let dynamics = source.dynamics.unwrap();
            let expected_radius = (source.radius
                + f64::from(frame.step) * b.time_step_seconds * dynamics.growth_rate)
                .min(dynamics.max_radius);
            areas.len() == 1
                && areas[0].center.x == source.center.x
                && areas[0].center.y == source.center.y
                && (areas[0].radius - expected_radius).abs() < 1e-9
        }),
        "gas must remain one growing cloud at its source"
    );
    assert!(
        gas.analytics
            .as_ref()
            .unwrap()
            .agents
            .iter()
            .all(|a| matches!(
                a.exit_id.as_deref(),
                Some("lab-east-exit" | "lab-south-east-exit")
            ))
    );
    // The first spawn zone uses the production spawner's first stable IDs.
    assert_eq!(b.spawn_zones[0].id, "lab-west-foyer");
    let foyer_count = b.spawn_zones[0].count;
    assert!((0..foyer_count).all(|id| crossing_height(&baseline, id, 17.0) < 9.0));
    for id in 0..foyer_count {
        assert!(crossing_height(&gas, id, 17.0) > 17.0 + b.agent_radius);
    }
    assert!(
        gas.frames[0]
            .blocked_opening_ids
            .as_ref()
            .unwrap()
            .is_empty()
    );
    assert!(
        gas.frames
            .iter()
            .all(|f| f.blocked_opening_ids.as_ref().unwrap().is_empty()),
        "the single cloud obstructs the upper corridor without inventing door closures"
    );
}

#[test]
fn school_gallery_setup_uses_real_furniture_and_the_cut_off_classrooms_window() {
    let b = building(SCHOOL);
    let result = run(&b);
    let counts = result.metrics.evacuated_by_route.as_ref().unwrap();
    assert_eq!(result.metrics.evacuated, 41);
    assert_eq!(counts.emergency_window, 9);
    assert_eq!(counts.normal_exit, 32);
    let classroom: BTreeSet<_> = result.frames[0]
        .agents
        .iter()
        .filter(|a| a.x < 14.0 && a.y < 11.0)
        .map(|a| a.id)
        .collect();
    assert_eq!(classroom.len(), 9);
    for agent in &result.analytics.as_ref().unwrap().agents {
        let route = agent.escape_route.as_ref().unwrap();
        if classroom.contains(&agent.id) {
            assert_eq!(route.kind, EscapeRouteKind::EmergencyWindow);
            assert_eq!(route.opening_id, "school-a-window");
        } else {
            assert_eq!(route.kind, EscapeRouteKind::NormalExit);
        }
    }
    assert!(
        result
            .frames
            .iter()
            .all(|f| f.blocked_opening_ids.as_ref().unwrap().is_empty())
    );
}
