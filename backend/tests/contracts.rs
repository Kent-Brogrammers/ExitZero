use exitzero::models::*;
use std::cmp::Ordering;

fn example() -> BuildingScenario {
    serde_json::from_str(include_str!("../../shared/examples/building.json")).unwrap()
}

#[test]
fn example_validates_and_round_trips_without_contract_changes() {
    let building = example();
    building.validate().unwrap();
    let original: serde_json::Value =
        serde_json::from_str(include_str!("../../shared/examples/building.json")).unwrap();
    assert_eq!(serde_json::to_value(building).unwrap(), original);
}

#[test]
fn rejects_invalid_buildings() {
    let original = serde_json::to_value(example()).unwrap();
    for (field, replacement) in [
        ("width", serde_json::json!(0)),
        ("height", serde_json::json!(513)),
        ("seed", serde_json::json!(9_007_199_254_740_992_u64)),
        ("max_steps", serde_json::json!(0)),
        ("walls", serde_json::json!([{"x": 30, "y": 0}])),
        (
            "doors",
            serde_json::json!([{"x": 2, "y": 2}, {"x": 2, "y": 2}]),
        ),
        (
            "exits",
            serde_json::json!([{"id": "a", "x": 0, "y": 1}, {"id": "a", "x": 29, "y": 1}]),
        ),
        ("exits", serde_json::json!([{"id": "a", "x": 3, "y": 3}])),
        ("blocked_exit_ids", serde_json::json!(["missing"])),
        ("spawn_zones", serde_json::json!([])),
        (
            "spawn_zones",
            serde_json::json!([{"x": 1, "y": 1, "width": 1, "height": 1, "count": 2}]),
        ),
        (
            "spawn_zones",
            serde_json::json!([{"x": 29, "y": 19, "width": 2, "height": 2, "count": 1}]),
        ),
        (
            "spawn_zones",
            serde_json::json!([
                {"x": 1, "y": 1, "width": 2, "height": 2, "count": 1},
                {"x": 2, "y": 2, "width": 2, "height": 2, "count": 1}
            ]),
        ),
    ] {
        let mut value = original.clone();
        value[field] = replacement;
        let building: BuildingScenario = serde_json::from_value(value).unwrap();
        assert!(building.validate().is_err(), "accepted invalid {field}");
    }
}

#[test]
fn rejects_spawn_on_obstacles_and_overlapping_cell_types() {
    let mut building = example();
    building.spawn_zones = vec![SpawnZone {
        x: 2,
        y: 2,
        width: 1,
        height: 1,
        count: 1,
    }];
    building.blocked_cells = vec![Cell { x: 2, y: 2 }];
    assert!(building.validate().is_err());
    let mut building = example();
    building.doors.push(building.walls[0]);
    assert!(building.validate().is_err());
}

#[test]
fn rejects_negative_and_unknown_json_fields() {
    let mut value = serde_json::to_value(example()).unwrap();
    value["width"] = serde_json::json!(-1);
    assert!(serde_json::from_value::<BuildingScenario>(value).is_err());
    let mut value = serde_json::to_value(example()).unwrap();
    value["spawnZones"] = serde_json::json!([]);
    assert!(serde_json::from_value::<BuildingScenario>(value).is_err());
}

#[test]
fn simulation_fixture_round_trips_and_validates() {
    let original: serde_json::Value =
        serde_json::from_str(include_str!("../../shared/examples/simulation.mock.json")).unwrap();
    let result: SimulationResult = serde_json::from_value(original.clone()).unwrap();
    result.validate().unwrap();
    assert_eq!(serde_json::to_value(&result).unwrap(), original);
    let mut invalid = result.clone();
    invalid.metrics.status = SimulationStatus::Completed;
    assert!(invalid.validate().is_err());
    let mut invalid = result.clone();
    invalid.metrics.clearance_steps = Some(0);
    assert!(invalid.validate().is_err());
    let mut invalid = result.clone();
    invalid.cell_visits.pop();
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
