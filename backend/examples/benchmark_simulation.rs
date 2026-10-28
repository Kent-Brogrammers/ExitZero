//! Compute-only benchmark: cargo run --release --example benchmark_simulation --
//! [output.json] [--scenario building.json] [--runs 3]
use exitzero::{models::BuildingScenario, simulation::simulate};
use std::{env, error::Error, fs, time::Instant};

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let (mut scenario_path, mut output_path, mut runs) = (None, None, 3_usize);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--scenario" => {
                scenario_path = Some(args.next().ok_or("--scenario needs a JSON path")?)
            }
            "--runs" => {
                runs = args
                    .next()
                    .ok_or("--runs needs a positive count")?
                    .parse()?;
                if runs == 0 {
                    return Err("--runs must be positive".into());
                }
            }
            "--help" | "-h" => {
                println!(
                    "benchmark_simulation [output.json] [--scenario building.json] [--runs 3]"
                );
                return Ok(());
            }
            _ if arg.starts_with('-') => return Err(format!("unknown option: {arg}").into()),
            _ if output_path.is_none() => output_path = Some(arg),
            _ => return Err("only one output JSON path is accepted".into()),
        }
    }

    let scenario: BuildingScenario = if let Some(path) = scenario_path {
        // Presets retain their actual population, seed and simulation settings.
        serde_json::from_str(&fs::read_to_string(path)?)?
    } else {
        let mut scenario: BuildingScenario =
            serde_json::from_str(include_str!("../../shared/examples/building.json"))?;
        // Preserve the original repeatable 30-person default benchmark.
        for zone in &mut scenario.spawn_zones {
            zone.count = 15;
        }
        scenario
    };
    scenario.validate()?;
    println!(
        "seed={}, population={}, walls={}, obstructions={}, dt={}, max_steps={}",
        scenario.seed,
        scenario
            .spawn_zones
            .iter()
            .map(|zone| zone.count)
            .sum::<u32>(),
        scenario.walls.len(),
        scenario.obstructions.len(),
        scenario.time_step_seconds,
        scenario.max_steps
    );
    for run in 0..runs {
        let start = Instant::now();
        let result = simulate(&scenario)?;
        let compute_seconds = start.elapsed().as_secs_f64();
        result.validate()?;
        println!(
            "run {}: {:.6}s, {} ticks, {} evacuated, {} sheltered, {} remaining, {} trapped, {:?}",
            run + 1,
            compute_seconds,
            result.frames.last().unwrap().step,
            result.metrics.evacuated,
            result.metrics.sheltered,
            result.metrics.remaining,
            result.metrics.trapped,
            result.metrics.status
        );
        if run == 0
            && let Some(path) = &output_path
        {
            fs::write(path, serde_json::to_vec(&result)?)?;
        }
    }
    Ok(())
}
