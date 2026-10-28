use exitzero::{models::BuildingScenario, simulation::simulate};
use serde_json::json;

fn room() -> BuildingScenario {
    serde_json::from_value(json!({
        "width":10,"height":10,
        "walls":[
            {"id":"north","start":{"x":0,"y":0},"end":{"x":10,"y":0},"thickness":0.2},
            {"id":"east","start":{"x":10,"y":0},"end":{"x":10,"y":10},"thickness":0.2},
            {"id":"south","start":{"x":10,"y":10},"end":{"x":0,"y":10},"thickness":0.2},
            {"id":"west","start":{"x":0,"y":10},"end":{"x":0,"y":0},"thickness":0.2}
        ],
        "doors":[],"exits":[{"id":"exit","wall_id":"north","offset":4,"width":2}],
        "spawn_zones":[],
        "placed_occupants":[{"id":"alice","name":"Reception","x":3.125,"y":4.625},{"id":"bob","x":7,"y":6}],
        "blocked_exit_ids":[],"obstructions":[],"agent_radius":0.2,"time_step_seconds":0.1,"seed":42,"max_steps":1000
    })).unwrap()
}

#[test]
fn exact_only_occupants_keep_centres_and_ids_in_real_recordings_and_evacuate() {
    let building = room();
    let restored: BuildingScenario =
        serde_json::from_str(&serde_json::to_string(&building).unwrap()).unwrap();
    let result = simulate(&restored).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.total_population, 2);
    assert_eq!(result.metrics.evacuated, 2);
    for (index, person) in building.placed_occupants.iter().enumerate() {
        let agent = &result.frames[0].agents[index];
        assert_eq!(
            (agent.id, agent.x, agent.y),
            (index as u32, person.x, person.y)
        );
    }
}

#[test]
fn mixed_area_sampling_reserves_exact_bodies_and_is_seeded() {
    let mut building = room();
    building.spawn_zones =
        serde_json::from_value(json!([{"id":"area","x":2,"y":2,"width":6,"height":6,"count":8}]))
            .unwrap();
    building.max_steps = 2;
    let first = simulate(&building).unwrap();
    let second = simulate(&building).unwrap();
    assert_eq!(first.metrics.total_population, 10);
    assert_eq!(
        serde_json::to_value(&first.frames).unwrap(),
        serde_json::to_value(&second.frames).unwrap()
    );
    for (index, agent) in first.frames[0].agents.iter().enumerate() {
        assert_eq!(agent.id, index as u32);
        for other in &first.frames[0].agents[..index] {
            assert!((agent.x - other.x).hypot(agent.y - other.y) >= 0.4);
        }
    }
    assert_eq!(
        (first.frames[0].agents[0].x, first.frames[0].agents[0].y),
        (3.125, 4.625)
    );
}

#[test]
fn invalid_exact_positions_fail_without_silent_relocation() {
    for case in [
        "wall",
        "furniture",
        "outside",
        "overlap",
        "blocked door",
        "window",
    ] {
        let mut building = room();
        building.max_steps = 1;
        match case {
            "wall" => {
                building.placed_occupants[0].y = 0.2;
            }
            "furniture" => {
                building.obstructions =
                    serde_json::from_value(json!([{"id":"desk","x":3,"y":4,"width":1,"height":1}]))
                        .unwrap();
            }
            "outside" => {
                building.placed_occupants[0].x = 0.1;
            }
            "overlap" => {
                building.placed_occupants[1].x = 3.2;
                building.placed_occupants[1].y = 4.625;
            }
            _ => {
                building.walls.push(serde_json::from_value(json!({"id":"divider","start":{"x":5,"y":0},"end":{"x":5,"y":10},"thickness":0.2})).unwrap());
                building.placed_occupants[0].x = 5.0;
                building.placed_occupants[0].y = 5.0;
                if case == "blocked door" {
                    building.doors = serde_json::from_value(
                        json!([{"id":"door","wall_id":"divider","offset":4,"width":2}]),
                    )
                    .unwrap();
                    building.opening_events = serde_json::from_value(
                        json!([{"step":0,"opening_id":"door","blocked":true}]),
                    )
                    .unwrap();
                } else {
                    building.windows = serde_json::from_value(
                        json!([{"id":"window","wall_id":"divider","offset":4,"width":2}]),
                    )
                    .unwrap();
                }
            }
        }
        let error = simulate(&building).err().expect(case).to_string();
        assert!(error.contains("placed occupant"), "{case}: {error}");
    }
}

#[test]
fn optional_field_preserves_legacy_area_initialization_and_contract_errors_are_clear() {
    let mut value = serde_json::to_value(room()).unwrap();
    value["spawn_zones"] = json!([{"id":"area","x":2,"y":2,"width":6,"height":6,"count":3}]);
    value["max_steps"] = json!(2);
    value.as_object_mut().unwrap().remove("placed_occupants");
    let legacy: BuildingScenario = serde_json::from_value(value.clone()).unwrap();
    value["placed_occupants"] = json!([]);
    let empty: BuildingScenario = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(
        serde_json::to_value(simulate(&legacy).unwrap().frames).unwrap(),
        serde_json::to_value(simulate(&empty).unwrap().frames).unwrap()
    );
    value["placed_occupants"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<BuildingScenario>(value).is_err());
    let mut duplicate = room();
    duplicate.placed_occupants[0].id = "exit".into();
    assert!(duplicate.validate().unwrap_err().contains("unique"));
    duplicate.placed_occupants[0].id = "alice".into();
    duplicate.placed_occupants[0].name = Some(" ".into());
    assert!(duplicate.validate().unwrap_err().contains("name"));
}

#[test]
fn real_stress_and_optimization_count_and_preserve_placed_occupants() {
    let building = room();
    let stress = exitzero::stress_testing::stress_test(&exitzero::models::StressTestRequest {
        building: building.clone(),
        config: exitzero::models::StressTestConfig {
            max_scenarios: 2,
            block_each_exit: true,
            obstruction_candidates: vec![],
        },
    })
    .unwrap();
    assert_eq!(stress.baseline.total_population, 2);
    assert!(
        stress
            .scenarios
            .iter()
            .all(|scenario| scenario.metrics.total_population == 2)
    );
    let optimized = exitzero::optimization::optimize(&exitzero::models::OptimizeRequest {
        building: building.clone(),
        max_candidates: 1,
    })
    .unwrap();
    assert_eq!(optimized.baseline.total_population, 2);
    for candidate in optimized.candidates {
        assert_eq!(candidate.metrics.total_population, 2);
        assert_eq!(
            serde_json::to_value(candidate.building.placed_occupants).unwrap(),
            serde_json::to_value(&building.placed_occupants).unwrap()
        );
    }
    let invalid: exitzero::models::StressTestRequest = serde_json::from_value(json!({
        "building": building,
        "config": {"max_scenarios":2,"block_each_exit":true,"obstruction_candidates":[{"id":"bad","x":3,"y":4,"width":1,"height":1}]}
    })).unwrap();
    assert!(invalid.validate().unwrap_err().contains("placed occupants"));
}
