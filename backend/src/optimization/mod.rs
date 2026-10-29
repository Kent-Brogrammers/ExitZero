use crate::{
    models::{
        BuildingScenario, OptimizationCandidate, OptimizationResult, OptimizeRequest,
        SimulationResult,
    },
    simulation::{SimulationError, control},
};
use std::{cmp::Ordering, collections::HashMap, collections::HashSet};

/// Evaluate independent door/exit widenings and return only verified improvements.
/// A successful empty candidate list means no tested layout beat the baseline.
pub fn optimize(request: &OptimizeRequest) -> Result<OptimizationResult, SimulationError> {
    optimize_with(request, crate::simulation::simulate)
}

// Synthetic simulators are injected only by this module's unit tests.
fn optimize_with(
    request: &OptimizeRequest,
    mut simulate: impl FnMut(&BuildingScenario) -> Result<SimulationResult, SimulationError>,
) -> Result<OptimizationResult, SimulationError> {
    request
        .validate()
        .map_err(SimulationError::InvalidScenario)?;
    control::checkpoint()?;
    let planned = generate_candidates(request);
    control::plan(planned.len() + 1);
    let (baseline, baseline_positions) = {
        let run = simulate(&request.building)?;
        control::checkpoint()?;
        control::evaluation_finished();
        validate_run(&run, &request.building)?;
        let positions = initial_positions(&run);
        (run.metrics, positions)
    }; // Discard playback and traffic data before evaluating candidates.
    let mut candidates = Vec::new();
    for building in planned {
        control::checkpoint()?;
        let run = simulate(&building)?;
        control::checkpoint()?;
        control::evaluation_finished();
        validate_run(&run, &building)?;
        let positions = initial_positions(&run);
        let (Some(original), Some(modified)) = (&baseline_positions, &positions) else {
            // Unlike StressScenarioResult, OptimizationCandidate has no description
            // or fairness field. Do not silently return unverified comparisons.
            return Err(SimulationError::InvalidScenario(
                "optimization fairness UNVERIFIED: baseline and candidate must provide complete pre-movement step-zero frames; the current optimization contract cannot disclose unverified comparisons"
                    .into(),
            ));
        };
        if original != modified {
            return Err(SimulationError::InvalidScenario(
                "optimization initial occupant positions differ from baseline; the simulator must preserve deterministic placement across opening modifications"
                    .into(),
            ));
        }
        if run.metrics.compare_severity(&baseline) == Ordering::Less {
            candidates.push(OptimizationCandidate {
                building,
                metrics: run.metrics,
                rank: 0,
            });
        }
    }
    // Lower severity is better. Stable sorting preserves enumeration order in ties.
    candidates.sort_by(|a, b| a.metrics.compare_severity(&b.metrics));
    let mut rank = 1;
    for index in 0..candidates.len() {
        if index > 0
            && candidates[index]
                .metrics
                .compare_severity(&candidates[index - 1].metrics)
                != Ordering::Equal
        {
            rank = index as u32 + 1;
        }
        candidates[index].rank = rank;
    }
    Ok(OptimizationResult {
        baseline,
        candidates,
    })
}

fn generate_candidates(request: &OptimizeRequest) -> Vec<BuildingScenario> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let doors = request
        .building
        .doors
        .iter()
        .enumerate()
        .map(|(index, opening)| (true, index, opening));
    let exits = request
        .building
        .exits
        .iter()
        .enumerate()
        .filter(|(_, opening)| !request.building.blocked_exit_ids.contains(&opening.id))
        .map(|(index, opening)| (false, index, opening));

    for (is_door, index, opening) in doors.chain(exits) {
        for extra_width in [0.5, 1.0] {
            let mut building = request.building.clone();
            let modified = if is_door {
                &mut building.doors[index]
            } else {
                &mut building.exits[index]
            };
            // Keep the start offset fixed; widen along the parent wall, even diagonally.
            modified.width += extra_width;
            let width = modified.width;
            if width <= opening.width || building.validate().is_err() {
                continue;
            }
            // Each layout changes exactly one globally unique opening ID and width.
            // This key therefore uniquely identifies configurations in this search.
            if !seen.insert((&opening.id, width.to_bits())) {
                continue;
            }
            candidates.push(building);
            if candidates.len() == request.max_candidates as usize {
                return candidates;
            }
        }
    }
    candidates
}

fn validate_run(
    run: &SimulationResult,
    building: &BuildingScenario,
) -> Result<(), SimulationError> {
    run.validate().map_err(|message| {
        SimulationError::InvalidScenario(format!(
            "invalid optimization simulation output: {message}"
        ))
    })?;
    let population = building.population() as u32;
    if run.metrics.total_population != population
        || run.width != building.width
        || run.height != building.height
        || run.time_step_seconds != building.time_step_seconds
        || run
            .metrics
            .clearance_steps
            .is_some_and(|steps| steps > building.max_steps)
        || run
            .frames
            .iter()
            .any(|frame| frame.step > building.max_steps)
    {
        return Err(SimulationError::InvalidScenario(
            "optimization simulation output does not match the requested population, workspace, time step, or step limit"
                .into(),
        ));
    }
    Ok(())
}

// Same principle as stress testing: compare actual complete positions by ID,
// never infer identical placement from matching seeds or partial frames.
fn initial_positions(run: &SimulationResult) -> Option<HashMap<u32, (f64, f64)>> {
    let frame = run.frames.first()?;
    if frame.step != 0 || frame.agents.len() != run.metrics.total_population as usize {
        return None;
    }
    Some(
        frame
            .agents
            .iter()
            .map(|agent| (agent.id, (agent.x, agent.y)))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AgentPosition, AnimationFrame, SimulationMetrics, SimulationStatus};
    use serde_json::{Value, json, to_value};

    #[test]
    fn cancellation_interrupts_a_real_candidate_without_returning_improvements() {
        let request = OptimizeRequest {
            building: crate::stress_testing::real_integration::room(),
            max_candidates: 2,
        };
        let control = std::sync::Arc::new(crate::simulation::ComputationControl::default());
        let mut calls = 0;
        let result = control.run(|| {
            optimize_with(&request, |building| {
                calls += 1;
                crate::simulation::simulate_live(building, &mut |frame| {
                    if calls == 2 && frame.step > 0 {
                        control.cancel();
                    }
                    true
                })
            })
        });
        assert!(matches!(result, Err(SimulationError::Cancelled)));
        assert_eq!(calls, 2);
        assert_eq!(control.progress().evaluations_completed, 1);
        assert!(control.progress().step > 0);
    }

    // All layouts, positions, and results here are explicitly synthetic unit-test data.
    // They test candidate evaluation, not real evacuation physics or passage capacity.
    fn request() -> OptimizeRequest {
        serde_json::from_value(json!({
            "max_candidates": 100,
            "building": {
                "width": 20.0, "height": 10.0,
                "walls": [{"id": "north", "start": {"x": 0.0, "y": 0.0},
                    "end": {"x": 20.0, "y": 0.0}, "thickness": 0.2}],
                "doors": [
                    {"id": "door-a", "wall_id": "north", "offset": 2.0, "width": 1.0},
                    {"id": "door-b", "wall_id": "north", "offset": 6.0, "width": 1.0}
                ],
                "exits": [
                    {"id": "exit-a", "wall_id": "north", "offset": 10.0, "width": 1.0},
                    {"id": "exit-b", "wall_id": "north", "offset": 17.0, "width": 1.0}
                ],
                "spawn_zones": [{"id": "occupants", "x": 2.0, "y": 3.0,
                    "width": 6.0, "height": 4.0, "count": 4}],
                "blocked_exit_ids": [],
                "obstructions": [{"id": "existing", "x": 12.0, "y": 5.0,
                    "width": 1.0, "height": 1.0}],
                "agent_radius": 0.25, "time_step_seconds": 0.25,
                "seed": 42, "max_steps": 1000
            }
        }))
        .unwrap()
    }

    fn completed(steps: u32) -> SimulationMetrics {
        SimulationMetrics {
            evacuated_by_route: None,
            sheltered: 0,
            status: SimulationStatus::Completed,
            total_population: 4,
            evacuated: 4,
            trapped: 0,
            remaining: 0,
            clearance_steps: Some(steps),
        }
    }

    fn unfinished(remaining: u32, trapped: u32) -> SimulationMetrics {
        SimulationMetrics {
            evacuated_by_route: None,
            sheltered: 0,
            status: SimulationStatus::Incomplete,
            total_population: 4,
            evacuated: 4 - remaining,
            trapped,
            remaining,
            clearance_steps: None,
        }
    }

    fn synthetic_run(building: &BuildingScenario, metrics: SimulationMetrics) -> SimulationResult {
        SimulationResult {
            termination_reason: None,
            metrics,
            frames: vec![AnimationFrame {
                pursuit: None,
                window_states: None,
                disaster_state: None,
                sheltered: None,
                blocked_opening_ids: None,
                step: 0,
                agents: (0..4)
                    .map(|id| AgentPosition {
                        injury: None,
                        id,
                        x: 3.0 + f64::from(id),
                        y: 4.0,
                    })
                    .collect(),
            }],
            traffic_samples: vec![],
            analytics: None,
            communication_events: None,
            agent_events: None,
            width: building.width,
            height: building.height,
            time_step_seconds: building.time_step_seconds,
        }
    }

    fn invalid_message(result: Result<OptimizationResult, SimulationError>) -> String {
        match result.unwrap_err() {
            SimulationError::InvalidScenario(message) => message,
            error => panic!("expected InvalidScenario, got {error:?}"),
        }
    }

    #[test]
    fn candidates_are_valid_unique_independent_single_opening_widenings() {
        let request = request();
        request.validate().unwrap();
        let original = to_value(&request).unwrap();
        let candidates = generate_candidates(&request);
        assert_eq!(candidates.len(), 8);
        let mut seen = HashSet::new();
        for (index, building) in candidates.iter().enumerate() {
            building.validate().unwrap();
            let mut expected = original["building"].clone();
            let field = if index < 4 { "doors" } else { "exits" };
            expected[field][index / 2 % 2]["width"] = json!(if index % 2 == 0 { 1.5 } else { 2.0 });
            assert_eq!(to_value(building).unwrap(), expected);
            assert!(seen.insert(serde_json::to_string(building).unwrap()));
        }
        assert_eq!(to_value(&request).unwrap(), original);
    }

    #[test]
    fn ordering_is_deterministic_and_respects_door_then_exit_input_order() {
        let mut request = request();
        request.building.doors.reverse();
        request.building.exits.reverse();
        let first = generate_candidates(&request);
        let second = generate_candidates(&request);
        assert_eq!(to_value(&first).unwrap(), to_value(second).unwrap());
        assert_eq!(first[0].doors[0].id, "door-b");
        assert_eq!(first[0].doors[0].width, 1.5);
        assert_eq!(first[1].doors[0].width, 2.0);
        assert_eq!(first[2].doors[1].id, "door-a");
        assert_eq!(first[2].doors[1].width, 1.5);
        assert_eq!(first[4].exits[0].id, "exit-b");
        assert_eq!(first[4].exits[0].width, 1.5);
    }

    #[test]
    fn overlapping_widenings_are_skipped_without_consuming_the_budget() {
        for next_is_exit in [false, true] {
            let mut request = request();
            request.max_candidates = 1;
            if next_is_exit {
                request.building.doors.truncate(1);
                request.building.exits[0].offset = 3.25;
            } else {
                request.building.doors[1].offset = 3.25;
            }
            request.validate().unwrap();
            let candidates = generate_candidates(&request);
            assert_eq!(candidates.len(), 1);
            assert_eq!(candidates[0].doors[0].width, 1.0); // Both proposals for door-a overlap.
            if next_is_exit {
                assert_eq!(candidates[0].exits[0].width, 1.5);
            } else {
                assert_eq!(candidates[0].doors[1].width, 1.5);
            }
            candidates[0].validate().unwrap();
        }
    }

    #[test]
    fn exit_widenings_respect_nearby_doors_and_wall_endpoints() {
        let mut request = request();
        request.building.exits[0].offset = 4.75; // Ends at 5.75, next door starts at 6.
        request.building.exits[1].offset = 18.5; // +0.5 m fits exactly, +1 m does not.
        request.validate().unwrap();
        let candidates = generate_candidates(&request);
        assert!(
            candidates
                .iter()
                .all(|building| building.exits[0].width == 1.0)
        );
        let widened: Vec<_> = candidates
            .iter()
            .filter(|building| building.exits[1].width > 1.0)
            .collect();
        assert_eq!(widened.len(), 1);
        assert_eq!(widened[0].exits[1].width, 1.5);
        assert_eq!(widened[0].exits[1].offset + widened[0].exits[1].width, 20.0);
        assert!(
            candidates
                .iter()
                .all(|building| building.validate().is_ok())
        );
    }

    #[test]
    fn diagonal_walls_use_along_wall_lengths_without_changing_offsets() {
        let mut request = request();
        request.building.height = 20.0;
        request.building.walls[0].end.x = 12.0;
        request.building.walls[0].end.y = 16.0; // Wall length remains 20 m.
        request.building.spawn_zones[0].x = 13.0;
        request.validate().unwrap();
        let candidates = generate_candidates(&request);
        assert_eq!(candidates.len(), 8);
        assert!(
            candidates
                .iter()
                .all(|building| building.validate().is_ok())
        );
        assert_eq!(candidates[7].exits[1].offset, 17.0);
        assert_eq!(candidates[7].exits[1].width, 2.0);
    }

    #[test]
    fn blocked_exits_are_not_widened_or_unblocked() {
        let mut request = request();
        request.building.blocked_exit_ids.push("exit-a".into());
        let candidates = generate_candidates(&request);
        assert_eq!(candidates.len(), 6);
        for building in candidates {
            assert_eq!(building.blocked_exit_ids, ["exit-a"]);
            assert_eq!(building.exits[0].width, 1.0);
        }
    }

    #[test]
    fn baseline_is_first_and_only_valid_evaluations_count_toward_the_budget() {
        for budget in [1, 2, 3, 8, 100] {
            let mut request = request();
            request.max_candidates = budget;
            let original = to_value(&request).unwrap();
            let mut calls = vec![];
            let result = optimize_with(&request, |building| {
                calls.push(to_value(building).unwrap());
                Ok(synthetic_run(building, completed(100)))
            })
            .unwrap();
            let expected = budget.min(8) as usize;
            assert_eq!(calls.len(), expected + 1);
            assert_eq!(calls[0], original["building"]);
            assert_eq!(
                calls[1..],
                to_value(generate_candidates(&request))
                    .unwrap()
                    .as_array()
                    .unwrap()[..]
            );
            assert!(result.candidates.is_empty()); // Equal results still consume the evaluation budget.
            assert_eq!(
                to_value(result.baseline).unwrap(),
                to_value(completed(100)).unwrap()
            );
            assert_eq!(to_value(&request).unwrap(), original);
        }
    }

    #[test]
    fn invalid_candidates_are_never_simulated_and_later_valid_candidates_fill_the_budget() {
        let mut request = request();
        request.max_candidates = 1;
        request.building.doors[1].offset = 3.25;
        let mut calls = 0;
        let result = optimize_with(&request, |building| {
            calls += 1;
            building.validate().unwrap();
            assert_eq!(building.doors[0].width, 1.0);
            if calls > 1 {
                assert_eq!(building.doors[1].width, 1.5);
            }
            Ok(synthetic_run(
                building,
                completed(if calls == 1 { 100 } else { 90 }),
            ))
        })
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(result.candidates.len(), 1);
    }

    #[test]
    fn only_strict_improvements_are_returned_best_first_with_stable_shared_ranks() {
        let request = request();
        let metrics = [
            completed(100),
            completed(90),
            completed(100),
            completed(110),
            unfinished(1, 0),
            completed(80),
            completed(90),
            completed(70),
            completed(100),
        ];
        let mut calls = 0;
        let result = optimize_with(&request, |building| {
            let run = synthetic_run(building, metrics[calls].clone());
            calls += 1;
            Ok(run)
        })
        .unwrap();
        assert_eq!(calls, 9);
        assert_eq!(
            result
                .candidates
                .iter()
                .map(|candidate| candidate.metrics.clearance_steps)
                .collect::<Vec<_>>(),
            [Some(70), Some(80), Some(90), Some(90)]
        );
        assert_eq!(
            result
                .candidates
                .iter()
                .map(|candidate| candidate.rank)
                .collect::<Vec<_>>(),
            [1, 2, 3, 3]
        );
        assert!(result.candidates.iter().all(|candidate| {
            candidate.metrics.compare_severity(&result.baseline) == Ordering::Less
        }));
        let expected = generate_candidates(&request);
        for (candidate, index) in result.candidates.iter().zip([6, 4, 0, 5]) {
            assert_eq!(
                to_value(&candidate.building).unwrap(),
                to_value(&expected[index]).unwrap()
            );
        }
    }

    #[test]
    fn incomplete_outcomes_use_remaining_then_trapped_and_completion_beats_all() {
        let mut request = request();
        request.max_candidates = 6;
        let timeout = SimulationMetrics {
            status: SimulationStatus::Timeout,
            ..unfinished(2, 0)
        };
        let metrics = [
            unfinished(3, 2),
            unfinished(3, 1),
            unfinished(2, 2),
            completed(1000),
            timeout.clone(),
            unfinished(3, 3),
            unfinished(2, 0),
        ];
        let mut calls = 0;
        let result = optimize_with(&request, |building| {
            let run = synthetic_run(building, metrics[calls].clone());
            calls += 1;
            Ok(run)
        })
        .unwrap();
        assert_eq!(result.candidates.len(), 5);
        assert_eq!(
            result
                .candidates
                .iter()
                .map(|candidate| (
                    candidate.metrics.remaining,
                    candidate.metrics.trapped,
                    candidate.rank
                ))
                .collect::<Vec<_>>(),
            [(0, 0, 1), (2, 0, 2), (2, 0, 2), (2, 2, 4), (3, 1, 5)]
        );
        assert_eq!(
            result.candidates[1].metrics.status,
            SimulationStatus::Timeout
        );
        assert_eq!(
            result.candidates[2].metrics.status,
            SimulationStatus::Incomplete
        );
        let value = to_value(&result).unwrap();
        assert_eq!(value["baseline"]["clearance_steps"], Value::Null);
        for candidate in &value["candidates"].as_array().unwrap()[1..] {
            assert_eq!(candidate["metrics"]["clearance_steps"], Value::Null);
        }
    }

    #[test]
    fn zero_step_clearance_is_valid_and_missing_clearance_is_never_zero() {
        for (baseline, evaluated, improves) in [
            (completed(0), completed(0), false),
            (completed(0), completed(1), false),
            (completed(1), completed(0), true),
            (completed(0), unfinished(1, 0), false),
            (unfinished(1, 0), completed(0), true),
            (unfinished(1, 0), unfinished(1, 0), false),
        ] {
            let mut request = request();
            request.max_candidates = 1;
            let mut calls = 0;
            let result = optimize_with(&request, |building| {
                calls += 1;
                Ok(synthetic_run(
                    building,
                    if calls == 1 {
                        baseline.clone()
                    } else {
                        evaluated.clone()
                    },
                ))
            })
            .unwrap();
            assert_eq!(
                result.candidates.len(),
                usize::from(improves),
                "baseline={baseline:?}, candidate={evaluated:?}"
            );
        }
    }

    #[test]
    fn no_better_layout_returns_an_empty_list_for_equal_or_worse_results() {
        for candidate_metrics in [completed(100), completed(120), unfinished(4, 4)] {
            let mut calls = 0;
            let result = optimize_with(&request(), |building| {
                calls += 1;
                Ok(synthetic_run(
                    building,
                    if calls == 1 {
                        completed(100)
                    } else {
                        candidate_metrics.clone()
                    },
                ))
            })
            .unwrap();
            assert_eq!(calls, 9);
            assert!(result.candidates.is_empty());
        }
    }

    #[test]
    fn no_valid_modifications_returns_baseline_without_requiring_a_comparison() {
        let mut request = request();
        request.building.doors.clear();
        request.building.exits.truncate(1);
        request.building.exits[0].offset = 0.0;
        request.building.exits[0].width = 20.0;
        let mut calls = 0;
        let result = optimize_with(&request, |building| {
            calls += 1;
            let mut run = synthetic_run(building, completed(100));
            run.frames.clear(); // No comparison is being claimed, so this is allowed.
            Ok(run)
        })
        .unwrap();
        assert_eq!(calls, 1);
        assert!(result.candidates.is_empty());
    }

    #[test]
    fn invalid_requests_fail_before_simulation() {
        for invalid_kind in 0..4 {
            let mut request = request();
            match invalid_kind {
                0 => request.max_candidates = 0,
                1 => request.max_candidates = 101,
                2 => request.building.doors[0].wall_id = "missing-wall".into(),
                _ => request.building.doors[0].offset = 6.0,
            }
            let result = optimize_with(&request, |_| {
                panic!("invalid request must not run simulation")
            });
            assert!(matches!(result, Err(SimulationError::InvalidScenario(_))));
        }
    }

    #[test]
    fn initial_positions_are_verified_by_agent_id_regardless_of_vector_order() {
        let mut calls = 0;
        let result = optimize_with(&request(), |building| {
            calls += 1;
            let mut run = synthetic_run(building, completed(if calls == 1 { 100 } else { 90 }));
            if calls > 1 {
                run.frames[0].agents.reverse();
            }
            Ok(run)
        })
        .unwrap();
        assert_eq!(result.candidates.len(), 8);
        assert!(
            result
                .candidates
                .iter()
                .all(|candidate| candidate.rank == 1)
        );
    }

    #[test]
    fn changed_initial_coordinates_or_ids_reject_the_comparison_despite_equal_seeds() {
        for change_id in [true, false] {
            let request = request();
            let original = to_value(&request).unwrap();
            let mut calls = 0;
            let result = optimize_with(&request, |building| {
                calls += 1;
                assert_eq!(building.seed, request.building.seed);
                let mut run = synthetic_run(building, completed(90));
                if calls == 2 {
                    if change_id {
                        run.frames[0].agents[0].id = 99;
                    } else {
                        run.frames[0].agents[0].x += 0.25;
                    }
                }
                Ok(run)
            });
            assert!(invalid_message(result).contains("initial occupant positions differ"));
            assert_eq!(calls, 2);
            assert_eq!(to_value(&request).unwrap(), original);
        }
    }

    #[test]
    fn missing_partial_or_later_frames_surface_unverified_fairness_as_an_error() {
        for baseline_missing in [true, false] {
            for missing_kind in 0..3 {
                let mut calls = 0;
                let result = optimize_with(&request(), |building| {
                    calls += 1;
                    let mut run = synthetic_run(building, completed(100));
                    if (calls == 1) == baseline_missing {
                        match missing_kind {
                            0 => run.frames.clear(),
                            1 => {
                                run.frames[0].agents.pop();
                            }
                            _ => run.frames[0].step = 1,
                        }
                    }
                    Ok(run)
                });
                let message = invalid_message(result);
                assert!(message.contains("fairness UNVERIFIED"));
                assert!(message.contains("complete pre-movement step-zero frames"));
                assert_eq!(calls, 2);
            }
        }
    }

    #[test]
    fn simulation_outputs_must_be_valid_and_match_the_requested_conditions() {
        for invalid_kind in 0..10 {
            for invalid_baseline in [true, false] {
                let mut calls = 0;
                let result = optimize_with(&request(), |building| {
                    calls += 1;
                    let mut run = synthetic_run(building, completed(100));
                    if (calls == 1) == invalid_baseline {
                        match invalid_kind {
                            0 => run.metrics.clearance_steps = None,
                            1 => run.metrics.trapped = 1,
                            2 => {
                                run.metrics.total_population = 5;
                                run.metrics.evacuated = 5;
                            }
                            3 => run.width += 1.0,
                            4 => run.height += 1.0,
                            5 => run.time_step_seconds /= 2.0,
                            6 => run.metrics.clearance_steps = Some(building.max_steps + 1),
                            7 => run.frames[0].step = building.max_steps + 1,
                            8 => run.frames[0].agents[0].x = f64::NAN,
                            _ => run.frames[0].agents[1].id = run.frames[0].agents[0].id,
                        }
                    }
                    Ok(run)
                });
                let message = invalid_message(result);
                assert!(message.contains("simulation output"));
                assert_eq!(calls, if invalid_baseline { 1 } else { 2 });
            }
        }
    }

    #[test]
    fn simulation_errors_propagate_even_after_an_improvement_without_partial_success() {
        for failing_call in [1, 3] {
            for not_implemented in [true, false] {
                let request = request();
                let original = to_value(&request).unwrap();
                let mut calls = 0;
                let result = optimize_with(&request, |building| {
                    calls += 1;
                    if calls == failing_call {
                        if not_implemented {
                            Err(SimulationError::NotImplemented)
                        } else {
                            Err(SimulationError::InvalidScenario(
                                "synthetic engine failure".into(),
                            ))
                        }
                    } else {
                        Ok(synthetic_run(
                            building,
                            completed(if calls == 1 { 100 } else { 90 }),
                        ))
                    }
                });
                if not_implemented {
                    assert!(matches!(result, Err(SimulationError::NotImplemented)));
                } else {
                    assert_eq!(invalid_message(result), "synthetic engine failure");
                }
                assert_eq!(calls, failing_call);
                assert_eq!(to_value(&request).unwrap(), original);
            }
        }
    }

    #[test]
    fn deterministic_evaluations_return_identical_ranked_results() {
        let request = request();
        let evaluate = || {
            let mut calls = 0;
            optimize_with(&request, |building| {
                calls += 1;
                Ok(synthetic_run(
                    building,
                    completed(if calls == 1 { 100 } else { 90 }),
                ))
            })
            .unwrap()
        };
        assert_eq!(to_value(evaluate()).unwrap(), to_value(evaluate()).unwrap());
    }

    #[test]
    fn production_entry_point_matches_the_real_simulator_and_validates_requests() {
        let mut request = request();
        let baseline = crate::simulation::simulate(&request.building).unwrap();
        baseline.validate().unwrap();
        let result = optimize(&request).unwrap();
        assert_eq!(
            to_value(result.baseline).unwrap(),
            to_value(baseline.metrics).unwrap()
        );
        request.max_candidates = 0;
        assert!(matches!(
            optimize(&request),
            Err(SimulationError::InvalidScenario(_))
        ));
    }
}

#[cfg(test)]
mod real_integration {
    use super::*;
    use crate::{
        models::{Opening, SimulationStatus},
        stress_testing::real_integration::{room, simulate_checked, split_room},
    };
    use serde_json::to_value;

    fn audit(label: &str, request: &OptimizeRequest) -> OptimizationResult {
        let original = to_value(request).unwrap();
        let baseline = simulate_checked(&request.building);
        let result = optimize(request).unwrap();
        assert_eq!(
            to_value(&result.baseline).unwrap(),
            to_value(&baseline.metrics).unwrap()
        );
        let mut expected_improvements = Vec::new();
        for building in generate_candidates(request) {
            let run = simulate_checked(&building);
            assert_eq!(initial_positions(&baseline), initial_positions(&run));
            if run.metrics.compare_severity(&baseline.metrics).is_lt() {
                expected_improvements
                    .push((to_value(building).unwrap(), to_value(run.metrics).unwrap()));
            }
        }
        assert_eq!(result.candidates.len(), expected_improvements.len());
        assert!(result.candidates.len() <= request.max_candidates as usize);
        eprintln!("real optimization {label} baseline: {:?}", baseline.metrics);
        let mut seen = HashSet::new();
        for candidate in &result.candidates {
            let layout = to_value(&candidate.building).unwrap();
            assert!(
                expected_improvements
                    .contains(&(layout.clone(), to_value(&candidate.metrics).unwrap()))
            );
            assert!(seen.insert(layout.to_string()));
            assert!(
                candidate
                    .metrics
                    .compare_severity(&baseline.metrics)
                    .is_lt()
            );
            let better = result
                .candidates
                .iter()
                .filter(|other| other.metrics.compare_severity(&candidate.metrics).is_lt())
                .count();
            assert_eq!(candidate.rank, better as u32 + 1);
            let changes: Vec<_> = request
                .building
                .doors
                .iter()
                .chain(&request.building.exits)
                .zip(
                    candidate
                        .building
                        .doors
                        .iter()
                        .chain(&candidate.building.exits),
                )
                .filter(|(before, after)| before.width != after.width)
                .map(|(before, after)| {
                    format!("{}: {} -> {} m", before.id, before.width, after.width)
                })
                .collect();
            assert_eq!(changes.len(), 1);
            eprintln!(
                "real optimization {label} {changes:?}: {:?}, rank={}",
                candidate.metrics, candidate.rank
            );
        }
        assert!(
            result
                .candidates
                .windows(2)
                .all(|pair| !pair[0].metrics.compare_severity(&pair[1].metrics).is_gt())
        );
        assert_eq!(to_value(request).unwrap(), original);
        result
    }

    fn narrow_door() -> BuildingScenario {
        let mut building = split_room();
        building.spawn_zones.truncate(1);
        building.exits.remove(0); // Only the exit in the right-hand room remains.
        building.doors.push(Opening {
            id: "narrow-door".into(),
            name: None,
            wall_id: "divider".into(),
            offset: 3.0,
            width: 0.4,
        });
        building
    }

    #[test]
    fn real_door_widening_connects_an_occupant_to_the_exit_and_improves_clearance() {
        let request = OptimizeRequest {
            building: narrow_door(),
            max_candidates: 2,
        };
        let result = audit("narrow door", &request);
        assert_eq!(result.baseline.status, SimulationStatus::Incomplete);
        assert!(result.baseline.clearance_steps.is_none());
        assert_eq!(result.candidates.len(), 2);
        for candidate in result.candidates {
            assert_eq!(candidate.metrics.status, SimulationStatus::Completed);
            assert_eq!(candidate.metrics.remaining, 0);
            assert!(candidate.metrics.clearance_steps.is_some());
            assert!(candidate.building.doors[0].width > request.building.doors[0].width);
            assert_eq!(
                candidate.building.doors[0].offset,
                request.building.doors[0].offset
            );
            assert_eq!(
                to_value(candidate.building.exits).unwrap(),
                to_value(&request.building.exits).unwrap()
            );
        }
    }

    #[test]
    fn real_exit_widening_turns_an_incomplete_baseline_into_completed_evacuations() {
        let mut building = room();
        building.exits.truncate(1);
        building.exits[0].width = 0.4;
        let request = OptimizeRequest {
            building,
            max_candidates: 2,
        };
        let result = audit("narrow exit", &request);
        assert_eq!(result.baseline.status, SimulationStatus::Incomplete);
        assert_eq!(result.baseline.remaining, 1);
        assert!(result.baseline.clearance_steps.is_none());
        assert_eq!(result.candidates.len(), 2);
        for candidate in result.candidates {
            assert_eq!(candidate.metrics.status, SimulationStatus::Completed);
            assert_eq!(candidate.metrics.evacuated, 1);
            assert!(candidate.building.exits[0].width > request.building.exits[0].width);
            assert_eq!(
                candidate.building.exits[0].offset,
                request.building.exits[0].offset
            );
        }
    }

    #[test]
    fn real_equal_or_worse_widenings_return_no_improvements() {
        let mut building = room();
        building.exits.truncate(1);
        let request = OptimizeRequest {
            building,
            max_candidates: 2,
        };
        let result = audit("already clear", &request);
        assert_eq!(result.baseline.status, SimulationStatus::Completed);
        assert!(result.candidates.is_empty());
    }

    #[test]
    fn real_partial_evacuation_and_timeout_keep_null_clearance_without_false_improvement() {
        let mut isolated = split_room();
        isolated.blocked_exit_ids.push("left".into());
        let request = OptimizeRequest {
            building: isolated,
            max_candidates: 2,
        };
        let result = audit("isolated room", &request);
        assert_eq!(result.baseline.status, SimulationStatus::Incomplete);
        assert_eq!(result.baseline.remaining, 1);
        assert!(result.baseline.clearance_steps.is_none());
        assert!(result.candidates.is_empty());
        let mut timed = room();
        timed.max_steps = 1;
        let result = audit(
            "timeout",
            &OptimizeRequest {
                building: timed,
                max_candidates: 2,
            },
        );
        assert_eq!(result.baseline.status, SimulationStatus::Timeout);
        assert!(result.baseline.clearance_steps.is_none());
        assert!(result.candidates.is_empty());
    }

    #[test]
    fn real_evaluations_respect_the_budget_and_do_not_change_starting_positions() {
        for budget in [1, 2] {
            let request = OptimizeRequest {
                building: narrow_door(),
                max_candidates: budget,
            };
            let mut starts = Vec::new();
            let counted = optimize_with(&request, |building| {
                let run = simulate_checked(building);
                starts.push(initial_positions(&run).unwrap());
                Ok(run)
            })
            .unwrap();
            assert_eq!(starts.len(), budget as usize + 1);
            assert!(starts.iter().all(|start| start == &starts[0]));
            assert_eq!(
                to_value(&counted).unwrap(),
                to_value(optimize(&request).unwrap()).unwrap()
            );
            assert_eq!(counted.candidates.len(), budget as usize);
        }
    }

    #[test]
    fn real_checked_in_example_optimization_matches_individually_measured_candidates() {
        let building: BuildingScenario =
            serde_json::from_str(include_str!("../../../shared/examples/building.json")).unwrap();
        let result = audit(
            "checked-in example",
            &OptimizeRequest {
                building,
                max_candidates: 8,
            },
        );
        assert_eq!(result.baseline.total_population, 34);
        assert_eq!(result.baseline.status, SimulationStatus::Completed);
        // The audit above compares every result with independently simulated
        // candidates. Widening this fixture need not improve centre-arrival
        // evacuation; an empty set of improvements is a valid measured result.
    }

    #[test]
    fn real_placement_errors_propagate_from_the_shared_engine() {
        let mut building = room();
        building.spawn_zones[0].height = 0.8;
        building.spawn_zones[0].count = 2;
        building.validate().unwrap();
        let error = crate::simulation::simulate(&building)
            .unwrap_err()
            .to_string();
        assert!(error.contains("could not place occupant"));
        assert_eq!(
            optimize(&OptimizeRequest {
                building,
                max_candidates: 1
            })
            .unwrap_err()
            .to_string(),
            error
        );
    }

    #[test]
    fn real_building_to_stress_to_optimization_to_comparison_workflow() {
        let building = narrow_door();
        let stress_request = crate::models::StressTestRequest {
            building: building.clone(),
            config: crate::models::StressTestConfig {
                max_scenarios: 1,
                block_each_exit: true,
                obstruction_candidates: vec![],
            },
        };
        let before = crate::stress_testing::stress_test(&stress_request).unwrap();
        let result = audit(
            "end-to-end",
            &OptimizeRequest {
                building,
                max_candidates: 2,
            },
        );
        assert_eq!(
            to_value(&before.baseline).unwrap(),
            to_value(&result.baseline).unwrap()
        );
        let best = &result.candidates[0];
        let mut after_request = stress_request;
        after_request.building = best.building.clone();
        let after = crate::stress_testing::stress_test(&after_request).unwrap();
        assert!(after.baseline.compare_severity(&before.baseline).is_lt());
        assert_eq!(after.baseline.status, SimulationStatus::Completed);
        assert_eq!(after.scenarios[0].metrics.trapped, 1); // Widening does not mask a disabled exit.
        assert!(after.scenarios[0].metrics.clearance_steps.is_none());
        assert!(after.scenarios[0].description.contains("fairness verified"));
    }
}
