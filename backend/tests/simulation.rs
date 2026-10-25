use exitzero::{
    models::{BuildingScenario, SimulationStatus},
    simulation::simulate,
};
use serde_json::json;

fn symmetric_exit(width: f64, blocked: bool, seed: u64) -> BuildingScenario {
    serde_json::from_value(json!({
        "width": 10.0, "height": 10.0,
        "walls": [{"id":"north", "start":{"x":0.0,"y":0.0}, "end":{"x":10.0,"y":0.0}, "thickness":0.2}],
        "doors": [], "exits": [{"id":"out", "wall_id":"north", "offset":5.0-width/2.0,"width":width}],
        "spawn_zones": [
            {"id":"left", "x":0.8,"y":0.8,"width":0.4,"height":0.4,"count":1},
            {"id":"right", "x":8.8,"y":0.8,"width":0.4,"height":0.4,"count":1}
        ],
        "blocked_exit_ids": if blocked { vec!["out"] } else { vec![] },
        "obstructions": [], "agent_radius":0.2,"time_step_seconds":0.1,"max_steps":1000,"seed":seed
    })).unwrap()
}

#[test]
fn symmetric_occupants_clear_a_wide_exit_without_overlap_or_teleportation() {
    for seed in [0, 1, 42] {
        let building = symmetric_exit(4.0, false, seed);
        let result = simulate(&building).unwrap();
        result.validate().unwrap();
        assert_eq!(
            result.metrics.status,
            SimulationStatus::Completed,
            "seed {seed}"
        );
        assert_eq!(result.metrics.evacuated, 2);
        assert!(result.metrics.clearance_steps.unwrap() < building.max_steps);
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            serde_json::to_value(simulate(&building).unwrap()).unwrap()
        );
        assert_eq!(result.frames[0].step, 0);
        assert_eq!(result.frames[0].agents.len(), 2);
        for pair in result.frames.windows(2) {
            assert_eq!(pair[1].step, pair[0].step + 1);
            let mut moves = Vec::new();
            for agent in &pair[0].agents {
                let end = pair[1]
                    .agents
                    .iter()
                    .find(|next| next.id == agent.id)
                    .map(|next| (next.x, next.y))
                    .unwrap_or_else(|| {
                        // Main now evacuates across the usable exit span, not
                        // only its centre. Check an actual recorded evacuation
                        // and a reachable body-clear point on that span.
                        let outcome = result
                            .analytics
                            .as_ref()
                            .unwrap()
                            .agents
                            .iter()
                            .find(|a| a.id == agent.id)
                            .unwrap();
                        assert_eq!(outcome.evacuation_step, Some(pair[1].step));
                        assert_eq!(outcome.exit_id.as_deref(), Some("out"));
                        let opening = &building.exits[0];
                        let clearance =
                            building.agent_radius + building.walls[0].thickness / 2.0 + 1e-6;
                        (
                            agent.x.clamp(
                                opening.offset + clearance,
                                opening.offset + opening.width - clearance,
                            ),
                            0.0,
                        )
                    });
                assert!(
                    (end.0 - agent.x).hypot(end.1 - agent.y)
                        <= 1.3 * building.time_step_seconds + 1e-8
                );
                // Any centre closer than radius to the north wall must be in
                // its actual opening, with disc clearance at both jambs.
                for t in 0..=20 {
                    let fraction = f64::from(t) / 20.0;
                    let x = agent.x + (end.0 - agent.x) * fraction;
                    let y = agent.y + (end.1 - agent.y) * fraction;
                    assert!(y >= -1e-8);
                    if y < 0.3 {
                        assert!((3.2 - 1e-8..=6.8 + 1e-8).contains(&x));
                    }
                }
                moves.push(((agent.x, agent.y), end));
            }
            if moves.len() == 2 {
                let (a, b) = (moves[0], moves[1]);
                let start = (a.0.0 - b.0.0, a.0.1 - b.0.1);
                let velocity = (
                    (a.1.0 - a.0.0) - (b.1.0 - b.0.0),
                    (a.1.1 - a.0.1) - (b.1.1 - b.0.1),
                );
                let square = velocity.0 * velocity.0 + velocity.1 * velocity.1;
                let t = if square == 0.0 {
                    0.0
                } else {
                    (-(start.0 * velocity.0 + start.1 * velocity.1) / square).clamp(0.0, 1.0)
                };
                assert!((start.0 + t * velocity.0).hypot(start.1 + t * velocity.1) >= 0.4 - 1e-8);
            }
        }
    }
}

#[test]
fn recovery_never_evacuates_through_disabled_or_impassable_exits() {
    for building in [
        symmetric_exit(4.0, true, 42),
        symmetric_exit(0.3, false, 42),
    ] {
        let result = simulate(&building).unwrap();
        result.validate().unwrap();
        assert_eq!(result.metrics.status, SimulationStatus::Incomplete);
        assert_eq!(result.metrics.remaining, 2);
        assert_eq!(result.metrics.evacuated, 0);
        assert_eq!(result.metrics.clearance_steps, None);
    }
}

#[test]
fn opening_passability_includes_body_radius_and_rounded_jambs() {
    let mut building = symmetric_exit(0.5, false, 42);
    building.spawn_zones.pop();
    let blocked = simulate(&building).unwrap();
    blocked.validate().unwrap();
    assert_eq!(blocked.metrics.status, SimulationStatus::Incomplete);
    assert_eq!(blocked.metrics.evacuated, 0);
    assert_eq!(blocked.metrics.clearance_steps, None);
    building.exits[0].offset = 4.65;
    building.exits[0].width = 0.7;
    let result = simulate(&building).unwrap();
    result.validate().unwrap();
    assert_eq!(result.metrics.status, SimulationStatus::Completed);
    assert_eq!(result.metrics.evacuated, 1);
}
