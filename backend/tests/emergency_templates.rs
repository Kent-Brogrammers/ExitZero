//! The gallery's editable inputs must exercise the production engine, not fixtures of results.
use exitzero::{
    models::{BuildingScenario, EscapeRouteKind, Point, SimulationResult, SimulationStatus},
    simulation::simulate,
};
use std::collections::BTreeSet;

const FIRE: &str = include_str!("../../frontend/src/editor/presets/office-fire.json");
const TORNADO: &str = include_str!("../../frontend/src/editor/presets/community-tornado.json");
const GAS: &str = include_str!("../../frontend/src/editor/presets/laboratory-gas.json");
const SCHOOL: &str = include_str!("../../frontend/src/editor/presets/school-emergency.json");

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
fn office_fire_redirects_people_from_the_affected_exit_to_a_reachable_alternative() {
    let b = building(FIRE);
    let fire = run(&b);
    let mut clear = b.clone();
    clear.disaster = None;
    let baseline = run(&clear);
    assert_eq!(fire.metrics.evacuated, 22);
    assert!(
        fire.frames[0]
            .blocked_opening_ids
            .as_ref()
            .unwrap()
            .iter()
            .any(|id| id == "office-west-exit")
    );
    let baseline_people = &baseline.analytics.as_ref().unwrap().agents;
    let redirected: BTreeSet<_> = baseline_people
        .iter()
        .filter(|a| a.exit_id.as_deref() == Some("office-west-exit"))
        .map(|a| a.id)
        .collect();
    assert!(
        !redirected.is_empty(),
        "the no-fire baseline must actually use the west exit"
    );
    assert!(
        baseline.frames[0]
            .blocked_opening_ids
            .as_ref()
            .unwrap()
            .is_empty()
    );
    let people = &fire.analytics.as_ref().unwrap().agents;
    assert!(
        people
            .iter()
            .all(|a| a.exit_id.as_deref() == Some("office-east-exit") && a.injury == 0.0)
    );
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
    assert_eq!(result.metrics.sheltered, 30);
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
    assert_eq!(result.frames.last().unwrap().sheltered, Some(30));
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

fn segment_distance(point: Point, from: Point, to: Point) -> f64 {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let length_squared = dx * dx + dy * dy;
    let fraction = if length_squared == 0.0 {
        0.0
    } else {
        ((point.x - from.x) * dx + (point.y - from.y) * dy) / length_squared
    }
    .clamp(0.0, 1.0);
    (point.x - from.x - fraction * dx).hypot(point.y - from.y - fraction * dy)
}

#[test]
fn laboratory_gas_redirects_west_foyer_occupants_to_the_safe_lower_corridor() {
    let b = building(GAS);
    let gas = run(&b);
    let mut clear = b.clone();
    clear.disaster = None;
    let baseline = run(&clear);
    assert_eq!(gas.metrics.evacuated, 18);
    assert!(
        gas.analytics
            .as_ref()
            .unwrap()
            .agents
            .iter()
            .all(|a| a.exit_id.as_deref() == Some("lab-east-exit")
                && a.injury == 0.0
                && a.exposure_seconds == 0.0)
    );
    // The first spawn zone uses the production spawner's first stable IDs.
    assert_eq!(b.spawn_zones[0].id, "lab-west-foyer");
    let foyer_count = b.spawn_zones[0].count;
    assert!((0..foyer_count).any(|id| crossing_height(&baseline, id, 15.0) < 7.0));
    for id in 0..foyer_count {
        assert!(crossing_height(&gas, id, 15.0) > 15.0 + b.agent_radius);
    }
    // Actual recorded segments stay outside the existing gas exposure footprint.
    let hazard = b.disaster.unwrap();
    let clearance = hazard.exposure_radius() + b.agent_radius;
    for pair in gas.frames.windows(2) {
        for a in &pair[0].agents {
            if let Some(next) = pair[1].agents.iter().find(|next| next.id == a.id) {
                let distance = segment_distance(
                    hazard.center,
                    Point { x: a.x, y: a.y },
                    Point {
                        x: next.x,
                        y: next.y,
                    },
                );
                assert!(
                    distance >= clearance - 1e-6,
                    "agent {} crossed the gas exposure area",
                    a.id
                );
            }
        }
    }
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
