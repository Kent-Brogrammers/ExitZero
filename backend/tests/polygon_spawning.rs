use exitzero::{
    models::{BuildingScenario, Point, SimulationStatus},
    simulation::simulate,
};
use serde_json::json;

fn building() -> BuildingScenario {
    let mut b: serde_json::Value =
        serde_json::from_str(include_str!("../../shared/examples/building.json")).unwrap();
    b["walls"] = json!([{"id":"north","start":{"x":1,"y":1},"end":{"x":12,"y":1},"thickness":0.2}]);
    b["doors"] = json!([]);
    b["exits"] = json!([{"id":"out","wall_id":"north","offset":4,"width":3}]);
    b["obstructions"] = json!([]);
    b["blocked_exit_ids"] = json!([]);
    b["spawn_zones"] = json!([{"id":"region","x":2,"y":2,"width":8,"height":8,"count":20,
      "polygon":[{"x":2,"y":2},{"x":10,"y":2},{"x":10,"y":5},{"x":5,"y":5},{"x":5,"y":10},{"x":2,"y":10}],
      "holes":[[{"x":3,"y":3},{"x":4,"y":3},{"x":4,"y":4},{"x":3,"y":4}]]}]);
    serde_json::from_value(b).unwrap()
}
#[test]
fn rust_places_real_occupants_inside_concave_polygons_with_full_disc_and_hole_clearance() {
    let b = building();
    b.validate().unwrap();
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.total_population, 20);
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    for agent in &result.frames[0].agents {
        assert!(b.spawn_zones[0].contains_disc(
            Point {
                x: agent.x,
                y: agent.y
            },
            b.agent_radius
        ));
    }
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::to_value(simulate(&b).unwrap()).unwrap()
    );
    let restored: BuildingScenario =
        serde_json::from_value(serde_json::to_value(&b).unwrap()).unwrap();
    restored.validate().unwrap();
    assert_eq!(restored.spawn_zones[0].polygon.as_ref().unwrap().len(), 6);
}
#[test]
fn polygon_validation_rejects_crossed_edges_stale_bounds_and_invalid_holes() {
    let source = serde_json::to_value(building()).unwrap();
    for (field, value) in [
        (
            "polygon",
            json!([{"x":2,"y":2},{"x":10,"y":10},{"x":2,"y":10},{"x":10,"y":2}]),
        ),
        ("x", json!(1)),
        ("polygon", json!([])),
        (
            "holes",
            json!([[{"x":4,"y":4},{"x":8,"y":4},{"x":8,"y":8}]]),
        ),
    ] {
        let mut invalid = source.clone();
        invalid["spawn_zones"][0][field] = value;
        assert!(
            serde_json::from_value::<BuildingScenario>(invalid)
                .unwrap()
                .validate()
                .is_err()
        );
    }
}
#[test]
fn overlapping_bounds_do_not_reject_disjoint_polygons_or_regions_inside_holes() {
    let mut b = building();
    let inside = serde_json::from_value(
        json!({"id":"hole-occupant","x":3.1,"y":3.1,"width":0.8,"height":0.8,"count":1}),
    )
    .unwrap();
    b.spawn_zones.push(inside);
    b.validate().unwrap();
    b.spawn_zones[1].x = 2.2;
    b.spawn_zones[1].y = 2.2;
    assert!(b.validate().is_err());
    b.spawn_zones=serde_json::from_value(json!([
      {"id":"a","x":2,"y":2,"width":8,"height":8,"count":1,"polygon":[{"x":2,"y":2},{"x":10,"y":2},{"x":2,"y":10}]},
      {"id":"b","x":2,"y":2,"width":8,"height":8,"count":1,"polygon":[{"x":10,"y":2},{"x":10,"y":10},{"x":2,"y":10}]}
    ])).unwrap();
    b.validate().unwrap();
}

#[test]
fn exact_placements_keep_their_positions_and_ids_alongside_polygon_spawning() {
    let mut b = building();
    b.placed_occupants = serde_json::from_value(json!([{"id":"fixed","x":2.6,"y":2.6}])).unwrap();
    b.validate().unwrap();
    let result = simulate(&b).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.total_population, 21);
    let initial = &result.frames[0].agents;
    assert_eq!(initial[0].id, 0);
    assert_eq!(initial[0].x, 2.6);
    assert_eq!(initial[0].y, 2.6);
    for person in &initial[1..] {
        assert!(b.spawn_zones[0].contains_disc(
            Point {
                x: person.x,
                y: person.y
            },
            b.agent_radius
        ));
        assert!((person.x - 2.6).hypot(person.y - 2.6) >= 2.0 * b.agent_radius);
    }
}
