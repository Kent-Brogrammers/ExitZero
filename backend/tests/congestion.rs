use exitzero::{
    models::{AnimationFrame, BuildingScenario, CongestionSample, SimulationResult},
    simulation::{simulate, simulate_live},
};
use serde_json::json;
use std::collections::BTreeMap;

fn queue() -> BuildingScenario {
    serde_json::from_value(json!({
        "width": 10.0, "height": 10.0,
        "walls": [{"id":"north", "start":{"x":0.0,"y":0.0},
            "end":{"x":10.0,"y":0.0}, "thickness":0.2}],
        "doors": [],
        "exits": [{"id":"out", "wall_id":"north", "offset":4.6,"width":0.8}],
        "spawn_zones": [],
        "placed_occupants": [
            {"id":"first", "x":5.0, "y":1.0},
            {"id":"second", "x":5.0, "y":1.45},
            {"id":"third", "x":5.0, "y":1.9}
        ],
        "blocked_exit_ids": [], "obstructions": [], "agent_radius":0.2,
        "time_step_seconds":0.02,"max_steps":100000,"seed":7
    }))
    .unwrap()
}

fn accumulate<'a>(
    samples: impl Iterator<Item = &'a CongestionSample>,
) -> BTreeMap<(u64, u64), f64> {
    let mut result = BTreeMap::new();
    for sample in samples {
        *result
            .entry((sample.x.to_bits(), sample.y.to_bits()))
            .or_default() += sample.crowd_delay_seconds;
    }
    result
}

fn frame_totals(frames: &[AnimationFrame]) -> BTreeMap<(u64, u64), f64> {
    accumulate(
        frames
            .iter()
            .flat_map(|frame| frame.congestion_samples.as_ref().unwrap()),
    )
}

#[test]
fn real_queue_integrates_all_physics_ticks_for_distinct_saved_and_live_strides() {
    let building = queue();
    building.validate().unwrap();
    let mut live = Vec::new();
    let result = simulate_live(&building, &mut |frame| {
        live.push(frame.clone());
        true
    })
    .unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.evacuated, 3);
    let total = accumulate(result.congestion_samples.as_ref().unwrap().iter());
    assert!(
        total.values().sum::<f64>() > 0.0,
        "a real single-file queue must register delay"
    );
    assert!(
        result
            .frames
            .windows(2)
            .any(|frames| frames[1].step - frames[0].step > 1)
    );
    assert_ne!(result.frames[1].step, live[1].step);
    assert!(
        result.frames[0]
            .congestion_samples
            .as_ref()
            .unwrap()
            .is_empty()
    );
    assert!(live[0].congestion_samples.as_ref().unwrap().is_empty());
    assert_eq!(
        result.frames.last().unwrap().step,
        live.last().unwrap().step
    );
    assert!(live.last().unwrap().agents.is_empty());
    for observed in [frame_totals(&result.frames), frame_totals(&live)] {
        assert_eq!(
            total.keys().collect::<Vec<_>>(),
            observed.keys().collect::<Vec<_>>()
        );
        for (position, expected) in &total {
            assert!((observed[position] - expected).abs() < 1e-9);
        }
    }
    // Live observation cannot change the physical run or its aggregate metric.
    let batch = simulate(&building).unwrap();
    assert_eq!(
        serde_json::to_value(batch).unwrap(),
        serde_json::to_value(result).unwrap()
    );
}

#[test]
fn legacy_absence_and_computed_zero_remain_distinct_and_invalid_samples_are_rejected() {
    let legacy: SimulationResult =
        serde_json::from_str(include_str!("../../shared/examples/simulation.mock.json")).unwrap();
    legacy.validate().unwrap();
    assert!(legacy.congestion_samples.is_none());
    assert!(
        legacy
            .frames
            .iter()
            .all(|frame| frame.congestion_samples.is_none())
    );
    assert!(
        serde_json::to_value(&legacy)
            .unwrap()
            .get("congestion_samples")
            .is_none()
    );
    let mut result = legacy.clone();
    result.congestion_samples = Some(Vec::new());
    result.frames[0].congestion_samples = Some(Vec::new());
    result.validate().unwrap();
    for (x, y, crowd_delay_seconds) in [
        (1.0, 1.0, -0.1),
        (1.0, 1.0, f64::NAN),
        (1.0, 1.0, f64::INFINITY),
        (1.0, 1.0, 1_000_000_001.0),
        (f64::NAN, 1.0, 1.0),
        (-0.1, 1.0, 1.0),
        (legacy.width + 0.1, 1.0, 1.0),
        (1.0, legacy.height + 0.1, 1.0),
    ] {
        let sample = CongestionSample {
            x,
            y,
            crowd_delay_seconds,
        };
        let mut invalid = legacy.clone();
        invalid.congestion_samples = Some(vec![sample.clone()]);
        assert!(invalid.validate().is_err());
        invalid.congestion_samples = None;
        invalid.frames[0].congestion_samples = Some(vec![sample]);
        assert!(invalid.validate().is_err());
    }
}
