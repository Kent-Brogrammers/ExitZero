use exitzero::models::*;
use std::cmp::Ordering;

fn assert_equivalent_json(mut actual: serde_json::Value, mut expected: serde_json::Value) {
    fn normalize(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Number(number) => {
                *value = serde_json::json!(number.as_f64().unwrap())
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(normalize),
            serde_json::Value::Object(fields) => fields.values_mut().for_each(normalize),
            _ => (),
        }
    }
    // JSON numbers such as 30 and 30.0 have the same contract meaning.
    normalize(&mut actual);
    normalize(&mut expected);
    assert_eq!(actual, expected);
}

fn example() -> BuildingScenario {
    serde_json::from_str(include_str!("../../shared/examples/building.json")).unwrap()
}

#[test]
fn continuous_example_validates_and_round_trips() {
    let building = example();
    building.validate().unwrap();
    assert!(
        building
            .walls
            .iter()
            .any(|w| w.start.x != w.end.x && w.start.y != w.end.y)
    );
    let original: serde_json::Value =
        serde_json::from_str(include_str!("../../shared/examples/building.json")).unwrap();
    assert_equivalent_json(serde_json::to_value(building).unwrap(), original);
}

#[test]
fn rejects_invalid_geometry_and_spawn_configurations() {
    let original = serde_json::to_value(example()).unwrap();
    for (field, replacement) in [
        ("width", serde_json::json!(0)),
        ("height", serde_json::json!(1001)),
        ("seed", serde_json::json!(9_007_199_254_740_992_u64)),
        ("max_steps", serde_json::json!(0)),
        ("agent_radius", serde_json::json!(0)),
        ("time_step_seconds", serde_json::json!(0)),
        (
            "walls",
            serde_json::json!([{"id":"bad","start":{"x":0,"y":0},"end":{"x":31,"y":2},"thickness":0.2}]),
        ),
        (
            "exits",
            serde_json::json!([{"id":"a","wall_id":"missing","offset":0,"width":1}]),
        ),
        (
            "exits",
            serde_json::json!([{"id":"a","wall_id":"north","offset":25.5,"width":2}]),
        ),
        (
            "exits",
            serde_json::json!([{"id":"a","wall_id":"north","offset":1,"width":2},{"id":"a","wall_id":"north","offset":5,"width":1}]),
        ),
        ("blocked_exit_ids", serde_json::json!(["missing"])),
        ("spawn_zones", serde_json::json!([])),
        (
            "spawn_zones",
            serde_json::json!([{"id":"s","x":2,"y":2,"width":1,"height":1,"count":2}]),
        ),
        (
            "spawn_zones",
            serde_json::json!([{"id":"s","x":5,"y":5,"width":1,"height":1,"count":10}]),
        ),
        (
            "spawn_zones",
            serde_json::json!([{"id":"s","x":29,"y":19,"width":2,"height":2,"count":1}]),
        ),
        (
            "spawn_zones",
            serde_json::json!([{"id":"s1","x":5,"y":5,"width":2,"height":2,"count":1},{"id":"s2","x":6,"y":6,"width":2,"height":2,"count":1}]),
        ),
    ] {
        let mut value = original.clone();
        value[field] = replacement;
        let building: BuildingScenario = serde_json::from_value(value).unwrap();
        assert!(building.validate().is_err(), "accepted invalid {field}");
    }
}

#[test]
fn validates_openings_and_thick_angled_walls() {
    let mut building = example();
    building.doors[0].offset = building.doors[1].offset;
    assert!(building.validate().is_err());
    let mut building = example();
    building.walls.push(Wall {
        id: "crossing_spawn".into(),
        start: Point { x: 4.0, y: 4.0 },
        end: Point { x: 11.0, y: 9.0 },
        thickness: 0.2,
    });
    assert!(building.validate().is_err());
    let mut building = example();
    building.walls[0].start.x = f64::NAN;
    assert!(building.validate().is_err());
    let mut building = example();
    building.width = f64::INFINITY;
    assert!(building.validate().is_err());
}

#[test]
fn validates_obstruction_candidates_without_modifying_the_baseline() {
    let baseline = example();
    let mut request = StressTestRequest {
        building: baseline,
        config: StressTestConfig {
            max_scenarios: 10,
            block_each_exit: false,
            obstruction_candidates: vec![Obstruction {
                id: "block_door".into(),
                x: 14.5,
                y: 5.0,
                width: 1.0,
                height: 1.0,
            }],
        },
    };
    request.validate().unwrap();
    assert!(request.building.obstructions.is_empty());
    request.config.obstruction_candidates[0].x = 5.0;
    assert!(request.validate().is_err());
    request.config.obstruction_candidates[0].x = 31.0;
    assert!(request.validate().is_err());
}

#[test]
fn rejects_legacy_grid_json() {
    let mut value = serde_json::to_value(example()).unwrap();
    value["blocked_cells"] = serde_json::json!([]);
    assert!(serde_json::from_value::<BuildingScenario>(value).is_err());
}

#[test]
fn continuous_simulation_fixture_round_trips_and_validates() {
    let original: serde_json::Value =
        serde_json::from_str(include_str!("../../shared/examples/simulation.mock.json")).unwrap();
    let result: SimulationResult = serde_json::from_value(original.clone()).unwrap();
    result.validate().unwrap();
    assert_equivalent_json(serde_json::to_value(&result).unwrap(), original);
    let mut invalid = result.clone();
    invalid.metrics.status = SimulationStatus::Completed;
    assert!(invalid.validate().is_err());
    let mut invalid = result.clone();
    invalid.metrics.clearance_steps = Some(0);
    assert!(invalid.validate().is_err());
    let mut invalid = result.clone();
    invalid.traffic_samples[0].x = 999.0;
    assert!(invalid.validate().is_err());
    let mut invalid = result.clone();
    invalid.frames[0].agents[0].x = f64::NAN;
    assert!(invalid.validate().is_err());
    let mut invalid = result;
    invalid.metrics.trapped = invalid.metrics.remaining + 1;
    assert!(invalid.validate().is_err());
}

#[test]
fn severity_prioritizes_occupants_and_handles_null_clearance() {
    let complete = SimulationMetrics {
        status: SimulationStatus::Completed,
        total_population: 2,
        evacuated: 2,
        trapped: 0,
        remaining: 0,
        clearance_steps: Some(1000),
    };
    let incomplete = SimulationMetrics {
        status: SimulationStatus::Incomplete,
        total_population: 2,
        evacuated: 1,
        trapped: 1,
        remaining: 1,
        clearance_steps: None,
    };
    complete.validate().unwrap();
    incomplete.validate().unwrap();
    assert_eq!(incomplete.compare_severity(&complete), Ordering::Greater);
    let slower = SimulationMetrics {
        clearance_steps: Some(2000),
        ..complete.clone()
    };
    assert_eq!(slower.compare_severity(&complete), Ordering::Greater);
}
