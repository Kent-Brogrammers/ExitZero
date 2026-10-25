//! Compute-only benchmark: cargo run --example benchmark_simulation [--release]
use exitzero::{models::BuildingScenario, simulation::simulate};
use std::time::Instant;

fn main() {
    let mut scenario: BuildingScenario =
        serde_json::from_str(include_str!("../../shared/examples/building.json")).unwrap();
    // A repeatable 30-person version of the checked-in example.
    for zone in &mut scenario.spawn_zones {
        zone.count = 15;
    }
    for run in 0..3 {
        let start = Instant::now();
        let result = simulate(&scenario).unwrap();
        println!(
            "run {}: {:.3}s, {} ticks, {} evacuated, {:?}",
            run + 1,
            start.elapsed().as_secs_f64(),
            result.frames.last().unwrap().step,
            result.metrics.evacuated,
            result.metrics.status
        );
        if run == 0
            && let Some(path) = std::env::args().nth(1)
        {
            std::fs::write(path, serde_json::to_vec(&result).unwrap()).unwrap();
        }
    }
}
