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
        }
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

#[test]
fn pursuit_honors_job_cancellation_during_physics_without_finishing_the_run() {
    use exitzero::simulation::{ComputationControl, SimulationError};
    use std::sync::Arc;
    let building = house();
    let control = Arc::new(ComputationControl::default());
    let mut steps = Vec::new();
    let result = control.run(|| {
        simulate_live(&building, &mut |frame| {
            steps.push(frame.step);
            if frame.step == 1 {
                control.cancel();
            }
            true // Only the computation control stops this run, not the stream callback.
        })
    });
    assert!(matches!(result, Err(SimulationError::Cancelled)));
    assert_eq!(steps, vec![0, 1]);
    assert_eq!(control.progress().step, 1);
}
