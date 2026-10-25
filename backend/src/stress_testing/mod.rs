use crate::{
    models::{
        BuildingScenario, ScenarioModifications, Severity, SimulationMetrics, SimulationResult,
        StressScenarioResult, StressTestRequest, StressTestResult,
    },
    simulation::{SimulationError, control},
};
use std::{cmp::Ordering, collections::HashMap};

/// Run independent, bounded experiments through the shared simulation engine.
/// Descriptions disclose unverified initial placement; equal seeds alone are not proof.
pub fn stress_test(request: &StressTestRequest) -> Result<StressTestResult, SimulationError> {
    stress_test_with(request, crate::simulation::simulate)
}

// The private runner permits explicitly synthetic unit tests, never a production fallback.
fn stress_test_with(
    request: &StressTestRequest,
    mut simulate: impl FnMut(&BuildingScenario) -> Result<SimulationResult, SimulationError>,
) -> Result<StressTestResult, SimulationError> {
    request
        .validate()
        .map_err(SimulationError::InvalidScenario)?;
    control::checkpoint()?;
    let planned_scenarios = generate_scenarios(request);
    control::plan(planned_scenarios.len() + 1);
    let (baseline, baseline_positions) = {
        let run = simulate(&request.building)?;
        control::checkpoint()?;
        control::evaluation_finished();
        validate_run(&run, &request.building)?;
        let positions = initial_positions(&run);
        (run.metrics, positions)
    }; // Release baseline playback/traffic data before running modified scenarios.
    let mut scenarios = Vec::new();

    for planned in planned_scenarios {
        control::checkpoint()?;
        let building = apply_modifications(&request.building, &planned.modifications);
        building
            .validate()
            .map_err(SimulationError::InvalidScenario)?;
        let run = simulate(&building)?;
        control::checkpoint()?;
        control::evaluation_finished();
        validate_run(&run, &building)?;
        let positions = initial_positions(&run);
        let fairness = match (&baseline_positions, &positions) {
            (Some(original), Some(modified)) if original != modified => {
                return Err(SimulationError::InvalidScenario(format!(
                    "{}: initial occupant positions differ from baseline; Connor's simulator must reuse deterministic initial placement across modifications",
                    planned.scenario_id
                )));
            }
            (Some(_), Some(_)) => "Starting-position fairness verified by agent ID.",
            _ => {
                // TODO(Connor integration): expose complete pre-movement step-zero frames,
                // and keep placement independent of exit closures and added obstructions.
                // The shared contract currently allows missing or partial frames.
                "Starting-position fairness UNVERIFIED: baseline or scenario lacks a complete step-zero frame; Connor's simulator must provide complete initial positions to verify comparability."
            }
        };
        let comparison = match run.metrics.compare_severity(&baseline) {
            Ordering::Greater => "worse",
            Ordering::Equal => "equal",
            Ordering::Less => "improved",
        };
        scenarios.push(StressScenarioResult {
            scenario_id: planned.scenario_id,
            description: format!(
                "{} Outcome compared with baseline: {comparison}. {fairness}",
                planned.description
            ),
            modifications: planned.modifications,
            severity: severity(&baseline, &run.metrics),
            metrics: run.metrics,
            rank: 0, // Assigned after all successful runs are collected.
        });
    }
    rank_scenarios(&mut scenarios);
    Ok(StressTestResult {
        baseline,
        scenarios,
    })
}

fn apply_modifications(
    original: &BuildingScenario,
    changes: &ScenarioModifications,
) -> BuildingScenario {
    let mut building = original.clone();
    building
        .blocked_exit_ids
        .extend(changes.blocked_exit_ids.iter().cloned());
    building
        .opening_events
        .retain(|event| event.blocked || !changes.blocked_exit_ids.contains(&event.opening_id));
    building
        .obstructions
        .extend(changes.added_obstructions.iter().cloned());
    building
}

/// Replay a tested scenario using exactly the same forced-closure rules.
pub(crate) fn record_scenario(
    request: &StressTestRequest,
    id: &str,
    expected: &SimulationMetrics,
) -> Result<(BuildingScenario, SimulationResult), SimulationError> {
    request
        .validate()
        .map_err(SimulationError::InvalidScenario)?;
    control::checkpoint()?;
    let planned = generate_scenarios(request)
        .into_iter()
        .find(|s| s.scenario_id == id)
        .ok_or_else(|| {
            SimulationError::InvalidScenario(
                "This scenario was not tested by the source stress request.".into(),
            )
        })?;
    let building = apply_modifications(&request.building, &planned.modifications);
    let result = crate::simulation::simulate(&building)?;
    validate_run(&result, &building)?;
    if serde_json::to_string(&result.metrics).unwrap() != serde_json::to_string(expected).unwrap() {
        return Err(SimulationError::InvalidScenario(
            "Replay metrics do not match the tested scenario. Rerun stress testing.".into(),
        ));
    }
    Ok((building, result))
}

struct PlannedScenario {
    scenario_id: String,
    description: String,
    modifications: ScenarioModifications,
}

fn generate_scenarios(request: &StressTestRequest) -> Vec<PlannedScenario> {
    let exits = request
        .building
        .exits
        .iter()
        .filter(|exit| {
            request.config.block_each_exit && !request.building.blocked_exit_ids.contains(&exit.id)
        })
        .map(|exit| PlannedScenario {
            scenario_id: format!("block-exit:{}", exit.id),
            description: format!("Block exit '{}'.", exit.id),
            modifications: ScenarioModifications {
                blocked_exit_ids: vec![exit.id.clone()],
                added_obstructions: vec![],
            },
        });
    let obstructions = request
        .config
        .obstruction_candidates
        .iter()
        .map(|obstruction| PlannedScenario {
            scenario_id: format!("add-obstruction:{}", obstruction.id),
            description: format!("Add obstruction '{}'.", obstruction.id),
            modifications: ScenarioModifications {
                blocked_exit_ids: vec![],
                added_obstructions: vec![obstruction.clone()],
            },
        });
    exits
        .chain(obstructions)
        .take(request.config.max_scenarios as usize)
        .collect()
}

fn validate_run(
    run: &SimulationResult,
    building: &BuildingScenario,
) -> Result<(), SimulationError> {
    run.validate().map_err(|message| {
        SimulationError::InvalidScenario(format!("invalid simulation output: {message}"))
    })?;
    let population: u32 = building.spawn_zones.iter().map(|zone| zone.count).sum();
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
            "simulation output does not match the requested population, workspace, time step, or step limit"
                .into(),
        ));
    }
    Ok(())
}

// Only complete, validated pre-movement snapshots can establish comparability.
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

/// Exploratory labels for validated metrics, not life-safety thresholds.
fn severity(baseline: &SimulationMetrics, metrics: &SimulationMetrics) -> Severity {
    if metrics.remaining > 0 {
        return Severity::Critical;
    }
    if metrics.compare_severity(baseline) != Ordering::Greater {
        return Severity::Low;
    }
    // Integer cross-multiplication avoids division by a zero-step baseline.
    // None is never substituted with zero; a completed run improves on an
    // incomplete baseline and has already returned Low above.
    match (baseline.clearance_steps, metrics.clearance_steps) {
        (Some(original), Some(modified)) if u64::from(modified) * 2 >= u64::from(original) * 3 => {
            Severity::High
        }
        _ => Severity::Moderate,
    }
}

fn rank_scenarios(scenarios: &mut [StressScenarioResult]) {
    // Stable sort preserves generation order for equal outcomes.
    scenarios.sort_by(|a, b| b.metrics.compare_severity(&a.metrics));
    let mut rank = 1;
    for index in 0..scenarios.len() {
        if index > 0
            && scenarios[index]
                .metrics
                .compare_severity(&scenarios[index - 1].metrics)
                != Ordering::Equal
        {
            rank = index as u32 + 1;
        }
        scenarios[index].rank = rank;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        AgentPosition, AnimationFrame, Obstruction, Opening, Point, SimulationStatus, SpawnZone,
        StressTestConfig, Wall,
    };
    use serde_json::{Value, to_value};

    // All buildings, positions, and simulation results below are synthetic unit-test data.
    // These tests exercise Nick's experiment logic, not Connor's evacuation engine.
    fn request() -> StressTestRequest {
        StressTestRequest {
            building: BuildingScenario {
                pursuit: None,
                tornado_zones: vec![],
                disaster: None,
                awareness: Default::default(),
                opening_events: vec![],
                stair_areas: vec![],
                windows: vec![],
                window_escape_context: None,
                width: 20.0,
                height: 10.0,
                walls: vec![Wall {
                    id: "north".into(),
                    name: None,
                    start: Point { x: 0.0, y: 0.0 },
                    end: Point { x: 20.0, y: 0.0 },
                    thickness: 0.2,
                }],
                doors: vec![],
                exits: vec![
                    Opening {
                        id: "left".into(),
                        name: None,
                        wall_id: "north".into(),
                        offset: 1.0,
                        width: 2.0,
                    },
                    Opening {
                        id: "right".into(),
                        name: None,
                        wall_id: "north".into(),
                        offset: 16.0,
                        width: 2.0,
                    },
                ],
                spawn_zones: vec![SpawnZone {
                    id: "occupants".into(),
                    name: None,
                    x: 2.0,
                    y: 3.0,
                    width: 6.0,
                    height: 4.0,
                    count: 4,
                }],
                blocked_exit_ids: vec![],
                obstructions: vec![],
                agent_radius: 0.25,
                time_step_seconds: 0.25,
                seed: 42,
                max_steps: 1000,
            },
            config: StressTestConfig {
                max_scenarios: 10,
                block_each_exit: true,
                obstruction_candidates: vec![
                    obstruction("first", 11.0),
                    obstruction("second", 13.0),
                ],
            },
        }
    }

    fn obstruction(id: &str, x: f64) -> Obstruction {
        Obstruction {
            id: id.into(),
            name: None,
            x,
            y: 3.0,
            width: 1.0,
            height: 1.0,
        }
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

    fn unfinished(remaining: u32, trapped: u32, status: SimulationStatus) -> SimulationMetrics {
        SimulationMetrics {
            evacuated_by_route: None,
            sheltered: 0,
            status,
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
            width: building.width,
            height: building.height,
            time_step_seconds: building.time_step_seconds,
        }
    }

    fn ids(result: &StressTestResult) -> Vec<&str> {
        result
            .scenarios
            .iter()
            .map(|scenario| scenario.scenario_id.as_str())
            .collect()
    }

    fn invalid_message<T: std::fmt::Debug>(result: Result<T, SimulationError>) -> String {
        match result.unwrap_err() {
            SimulationError::InvalidScenario(message) => message,
            error => panic!("expected InvalidScenario, got {error:?}"),
        }
    }

    #[test]
    fn multiple_exits_and_obstructions_are_independent_and_preserve_the_request() {
        let mut request = request();
        request
            .building
            .obstructions
            .push(obstruction("existing", 15.0));
        let original = to_value(&request).unwrap();
        let mut calls = vec![];
        let result = stress_test_with(&request, |building| {
            calls.push(building.clone());
            Ok(synthetic_run(building, completed(100)))
        })
        .unwrap();

        assert_eq!(to_value(&request).unwrap(), original);
        assert_eq!(calls.len(), 5); // Baseline plus four independent modifications.
        assert_eq!(to_value(&calls[0]).unwrap(), original["building"]);
        assert_eq!(
            ids(&result),
            [
                "block-exit:left",
                "block-exit:right",
                "add-obstruction:first",
                "add-obstruction:second"
            ]
        );
        assert_eq!(
            to_value(&result.baseline).unwrap(),
            to_value(completed(100)).unwrap()
        );
        for (index, scenario) in result.scenarios.iter().enumerate() {
            let mut expected = original["building"].clone();
            if index < 2 {
                expected["blocked_exit_ids"] =
                    to_value([if index == 0 { "left" } else { "right" }]).unwrap();
                assert_eq!(
                    scenario.modifications.blocked_exit_ids,
                    calls[index + 1].blocked_exit_ids
                );
                assert!(scenario.modifications.added_obstructions.is_empty());
            } else {
                let candidate = &request.config.obstruction_candidates[index - 2];
                expected["obstructions"]
                    .as_array_mut()
                    .unwrap()
                    .push(to_value(candidate).unwrap());
                assert_eq!(
                    to_value(&scenario.modifications.added_obstructions).unwrap(),
                    to_value([candidate]).unwrap()
                );
                assert!(scenario.modifications.blocked_exit_ids.is_empty());
            }
            // All other fields, including spawn zones, seed, and existing obstacles, stay identical.
            assert_eq!(to_value(&calls[index + 1]).unwrap(), expected);
            assert_eq!(scenario.rank, 1);
            assert!(matches!(scenario.severity, Severity::Low));
            assert!(scenario.description.contains("fairness verified"));
            assert!(scenario.description.contains("baseline: equal"));
        }
    }

    #[test]
    fn one_budget_caps_generated_modifications_and_excludes_baseline() {
        for budget in [1, 2, 3, 4, 100] {
            let mut request = request();
            request.config.max_scenarios = budget;
            let mut calls = 0;
            let result = stress_test_with(&request, |building| {
                calls += 1;
                Ok(synthetic_run(building, completed(100)))
            })
            .unwrap();
            let expected = budget.min(4) as usize;
            assert_eq!(result.scenarios.len(), expected);
            assert_eq!(calls, expected + 1);
            assert_eq!(
                ids(&result),
                [
                    "block-exit:left",
                    "block-exit:right",
                    "add-obstruction:first",
                    "add-obstruction:second"
                ][..expected]
            );
        }
    }

    #[test]
    fn blocked_exits_are_skipped_without_consuming_budget_or_losing_existing_blocks() {
        let mut request = request();
        request.building.blocked_exit_ids.push("left".into());
        request.config.max_scenarios = 2;
        let mut calls = vec![];
        let result = stress_test_with(&request, |building| {
            calls.push(building.clone());
            Ok(synthetic_run(building, completed(100)))
        })
        .unwrap();
        assert_eq!(ids(&result), ["block-exit:right", "add-obstruction:first"]);
        assert_eq!(calls[1].blocked_exit_ids, ["left", "right"]);
        assert_eq!(
            result.scenarios[0].modifications.blocked_exit_ids,
            ["right"]
        );
        assert_eq!(calls[2].blocked_exit_ids, ["left"]);
        assert!(
            result.scenarios[1]
                .modifications
                .blocked_exit_ids
                .is_empty()
        );
        assert!(calls[1].obstructions.is_empty());
        assert_eq!(calls[2].obstructions.len(), 1);
    }

    #[test]
    fn forced_exit_closures_remove_only_conflicting_reopening_events() {
        let mut request = request();
        request.building.doors.push(Opening {
            id: "door".into(),
            name: None,
            wall_id: "north".into(),
            offset: 10.0,
            width: 1.0,
        });
        request.building.opening_events = serde_json::from_value(serde_json::json!([
            {"step": 0, "opening_id": "left", "blocked": false},
            {"step": 1, "opening_id": "right", "blocked": false},
            {"step": 2, "opening_id": "left", "blocked": true},
            {"step": 3, "opening_id": "left", "blocked": false},
            {"step": 4, "opening_id": "door", "blocked": false},
            {"step": 5, "opening_id": "right", "blocked": true}
        ]))
        .unwrap();
        let original = to_value(&request).unwrap();
        let events = original["building"]["opening_events"].as_array().unwrap();
        let mut calls = vec![];
        stress_test_with(&request, |building| {
            calls.push(building.clone());
            Ok(synthetic_run(building, completed(100)))
        })
        .unwrap();

        assert_eq!(calls.len(), 5);
        assert_eq!(to_value(&calls[0]).unwrap(), original["building"]);
        assert_eq!(calls[1].blocked_exit_ids, ["left"]);
        assert_eq!(
            to_value(&calls[1].opening_events).unwrap(),
            to_value([&events[1], &events[2], &events[4], &events[5]]).unwrap()
        );
        assert_eq!(calls[2].blocked_exit_ids, ["right"]);
        assert_eq!(
            to_value(&calls[2].opening_events).unwrap(),
            to_value([&events[0], &events[2], &events[3], &events[4], &events[5]]).unwrap()
        );
        for building in &calls[3..] {
            assert_eq!(
                to_value(&building.opening_events).unwrap(),
                original["building"]["opening_events"]
            );
        }
        assert_eq!(to_value(&request).unwrap(), original);
    }

    #[test]
    fn all_exits_blocked_leaves_the_budget_available_for_obstructions() {
        let mut request = request();
        request.building.blocked_exit_ids = vec!["left".into(), "right".into()];
        request.config.max_scenarios = 1;
        let result = stress_test_with(&request, |building| {
            Ok(synthetic_run(
                building,
                unfinished(4, 4, SimulationStatus::Incomplete),
            ))
        })
        .unwrap();
        assert_eq!(ids(&result), ["add-obstruction:first"]);
    }

    #[test]
    fn all_exits_blocked_without_candidates_returns_only_the_baseline() {
        let mut request = request();
        request.building.blocked_exit_ids = vec!["left".into(), "right".into()];
        request.config.obstruction_candidates.clear();
        let mut calls = 0;
        let result = stress_test_with(&request, |building| {
            calls += 1;
            Ok(synthetic_run(
                building,
                unfinished(4, 4, SimulationStatus::Incomplete),
            ))
        })
        .unwrap();
        assert_eq!(calls, 1);
        assert!(result.scenarios.is_empty());
        assert!(result.baseline.clearance_steps.is_none());
    }

    #[test]
    fn each_scenario_source_can_be_used_alone() {
        for exits_only in [true, false] {
            let mut request = request();
            if exits_only {
                request.config.obstruction_candidates.clear();
            } else {
                request.config.block_each_exit = false;
            }
            let result = stress_test_with(&request, |building| {
                Ok(synthetic_run(building, completed(100)))
            })
            .unwrap();
            assert_eq!(result.scenarios.len(), 2);
            assert!(ids(&result).iter().all(|id| id.starts_with(if exits_only {
                "block-exit:"
            } else {
                "add-obstruction:"
            })));
        }
    }

    #[test]
    fn invalid_requests_and_candidates_are_rejected_before_any_simulation() {
        let mut cases = vec![];
        let mut missing = request();
        missing.config.block_each_exit = false;
        missing.config.obstruction_candidates.clear();
        cases.push(("missing sources", missing));
        for budget in [0, 101] {
            let mut invalid = request();
            invalid.config.max_scenarios = budget;
            cases.push(("invalid budget", invalid));
        }
        for candidate in [
            obstruction("", 11.0),
            obstruction("left", 11.0),
            obstruction("outside", 20.0),
            obstruction("spawn-overlap", 3.0),
            obstruction("nan", f64::NAN),
            Obstruction {
                width: 0.0,
                ..obstruction("zero-width", 11.0)
            },
        ] {
            let mut invalid = request();
            invalid.config.max_scenarios = 1; // Even candidates beyond the budget must validate.
            invalid.config.obstruction_candidates.push(candidate);
            cases.push(("invalid candidate", invalid));
        }
        let mut duplicate = request();
        duplicate
            .config
            .obstruction_candidates
            .push(obstruction("first", 15.0));
        cases.push(("duplicate candidate ID", duplicate));
        let mut too_many = request();
        too_many.config.obstruction_candidates = (0..101)
            .map(|i| obstruction(&format!("candidate-{i}"), 11.0))
            .collect();
        cases.push(("too many candidates", too_many));
        let mut bad_building = request();
        bad_building
            .building
            .blocked_exit_ids
            .push("missing-exit".into());
        cases.push(("invalid building", bad_building));
        let mut obstruction_limit = request();
        obstruction_limit.building.obstructions = (0..100)
            .map(|i| obstruction(&format!("existing-{i}"), 15.0))
            .collect();
        cases.push((
            "candidate exceeds building obstruction limit",
            obstruction_limit,
        ));

        for (label, request) in cases {
            let mut calls = 0;
            let result = stress_test_with(&request, |_| {
                calls += 1;
                Err(SimulationError::NotImplemented)
            });
            assert!(
                matches!(result, Err(SimulationError::InvalidScenario(_))),
                "{label}: {result:?}"
            );
            assert_eq!(calls, 0, "{label}");
        }
    }

    #[test]
    fn generation_and_output_are_deterministic_and_follow_input_order() {
        let mut request = request();
        request.building.exits.reverse();
        request.config.obstruction_candidates.reverse();
        let run = || {
            stress_test_with(&request, |building| {
                Ok(synthetic_run(building, completed(100)))
            })
            .unwrap()
        };
        let first = run();
        let second = run();
        assert_eq!(
            ids(&first),
            [
                "block-exit:right",
                "block-exit:left",
                "add-obstruction:second",
                "add-obstruction:first"
            ]
        );
        assert_eq!(to_value(first).unwrap(), to_value(second).unwrap());
    }

    #[test]
    fn orchestration_collects_metrics_compares_to_baseline_and_ranks_worst_first() {
        let request = request();
        let metrics = [
            completed(100),
            completed(150),
            unfinished(1, 0, SimulationStatus::Incomplete),
            unfinished(2, 0, SimulationStatus::Timeout),
            completed(120),
        ];
        let mut calls = 0;
        let result = stress_test_with(&request, |building| {
            let run = synthetic_run(building, metrics[calls].clone());
            calls += 1;
            Ok(run)
        })
        .unwrap();
        assert_eq!(
            ids(&result),
            [
                "add-obstruction:first",
                "block-exit:right",
                "block-exit:left",
                "add-obstruction:second"
            ]
        );
        for (index, (scenario, original_index)) in
            result.scenarios.iter().zip([3, 2, 1, 4]).enumerate()
        {
            assert_eq!(scenario.rank, index as u32 + 1);
            assert_eq!(
                to_value(&scenario.metrics).unwrap(),
                to_value(&metrics[original_index]).unwrap()
            );
            assert!(scenario.description.contains("baseline: worse"));
        }
        assert!(matches!(result.scenarios[0].severity, Severity::Critical));
        assert!(matches!(result.scenarios[1].severity, Severity::Critical));
        assert!(matches!(result.scenarios[2].severity, Severity::High));
        assert!(matches!(result.scenarios[3].severity, Severity::Moderate));
    }

    #[test]
    fn ranking_uses_remaining_then_trapped_then_clearance_with_stable_shared_ranks() {
        let metrics = [
            completed(100),
            unfinished(1, 0, SimulationStatus::Timeout),
            completed(200),
            unfinished(1, 1, SimulationStatus::Incomplete),
            unfinished(2, 0, SimulationStatus::Timeout),
            unfinished(1, 0, SimulationStatus::Incomplete),
        ];
        let mut scenarios: Vec<_> = metrics
            .into_iter()
            .enumerate()
            .map(|(index, metrics)| {
                metrics.validate().unwrap();
                StressScenarioResult {
                    scenario_id: format!("synthetic-{index}"),
                    description: "Synthetic metrics for ranking only".into(),
                    modifications: ScenarioModifications {
                        blocked_exit_ids: vec![],
                        added_obstructions: vec![],
                    },
                    severity: severity(&completed(100), &metrics),
                    metrics,
                    rank: 0,
                }
            })
            .collect();
        rank_scenarios(&mut scenarios);
        assert_eq!(
            scenarios
                .iter()
                .map(|scenario| scenario.scenario_id.as_str())
                .collect::<Vec<_>>(),
            [
                "synthetic-4",
                "synthetic-3",
                "synthetic-1",
                "synthetic-5",
                "synthetic-2",
                "synthetic-0"
            ]
        );
        assert_eq!(
            scenarios
                .iter()
                .map(|scenario| scenario.rank)
                .collect::<Vec<_>>(),
            [1, 2, 3, 3, 5, 6]
        );
        assert!(
            scenarios[..4]
                .iter()
                .all(|scenario| scenario.metrics.clearance_steps.is_none())
        );
    }

    #[test]
    fn severity_handles_thresholds_incomplete_baselines_and_zero_clearance() {
        use Severity::{Critical, High, Low, Moderate};
        let incomplete = unfinished(2, 1, SimulationStatus::Incomplete);
        for (baseline, metrics, expected) in [
            (completed(100), completed(99), Low),
            (completed(100), completed(100), Low),
            (completed(100), completed(101), Moderate),
            (completed(100), completed(149), Moderate),
            (completed(100), completed(150), High),
            (completed(100), completed(151), High),
            (completed(3), completed(4), Moderate),
            (completed(3), completed(5), High),
            (completed(0), completed(0), Low),
            (completed(0), completed(1), High),
            (
                completed(100),
                unfinished(1, 0, SimulationStatus::Timeout),
                Critical,
            ),
            (
                completed(100),
                unfinished(1, 1, SimulationStatus::Incomplete),
                Critical,
            ),
            (incomplete.clone(), completed(0), Low),
            (incomplete.clone(), completed(1000), Low),
            (
                incomplete.clone(),
                unfinished(1, 0, SimulationStatus::Timeout),
                Critical,
            ),
            (incomplete.clone(), incomplete.clone(), Critical),
            (
                incomplete,
                unfinished(3, 0, SimulationStatus::Incomplete),
                Critical,
            ),
        ] {
            baseline.validate().unwrap();
            metrics.validate().unwrap();
            assert_eq!(
                to_value(severity(&baseline, &metrics)).unwrap(),
                to_value(expected).unwrap(),
                "baseline={baseline:?}, metrics={metrics:?}"
            );
        }
    }

    #[test]
    fn incomplete_baselines_preserve_null_and_describe_improvements() {
        let mut request = request();
        request.config.max_scenarios = 2;
        let metrics = [
            unfinished(3, 1, SimulationStatus::Timeout),
            completed(800),
            unfinished(1, 0, SimulationStatus::Incomplete),
        ];
        let mut calls = 0;
        let result = stress_test_with(&request, |building| {
            let run = synthetic_run(building, metrics[calls].clone());
            calls += 1;
            Ok(run)
        })
        .unwrap();
        assert!(result.baseline.clearance_steps.is_none());
        assert_eq!(
            to_value(&result).unwrap()["baseline"]["clearance_steps"],
            Value::Null
        );
        assert_eq!(ids(&result), ["block-exit:right", "block-exit:left"]);
        assert!(matches!(result.scenarios[0].severity, Severity::Critical));
        assert!(matches!(result.scenarios[1].severity, Severity::Low));
        assert!(
            result
                .scenarios
                .iter()
                .all(|scenario| scenario.description.contains("baseline: improved"))
        );
    }

    #[test]
    fn identical_initial_positions_are_matched_by_id_independent_of_frame_order() {
        let result = stress_test_with(&request(), |building| {
            let mut run = synthetic_run(building, completed(100));
            if !building.blocked_exit_ids.is_empty() || !building.obstructions.is_empty() {
                run.frames[0].agents.reverse();
            }
            Ok(run)
        })
        .unwrap();
        assert!(
            result
                .scenarios
                .iter()
                .all(|scenario| scenario.description.contains("fairness verified"))
        );
    }

    #[test]
    fn changed_initial_positions_or_agent_ids_fail_even_with_the_same_seed() {
        for change_id in [false, true] {
            let request = request();
            let original = to_value(&request).unwrap();
            let mut calls = 0;
            let error = stress_test_with(&request, |building| {
                assert_eq!(building.seed, request.building.seed);
                calls += 1;
                let mut run = synthetic_run(building, completed(100));
                if calls == 2 {
                    if change_id {
                        run.frames[0].agents[0].id = 99;
                    } else {
                        run.frames[0].agents[0].x += 0.25;
                    }
                }
                Ok(run)
            });
            let message = invalid_message(error);
            assert!(message.contains("block-exit:left"));
            assert!(message.contains("initial occupant positions differ"));
            assert_eq!(calls, 2);
            assert_eq!(to_value(&request).unwrap(), original);
        }
    }

    #[test]
    fn absent_partial_or_later_initial_frames_are_explicitly_unverified() {
        // A valid result need not contain a full step-zero frame, on either side.
        for incomplete_baseline_frame in [true, false] {
            for missing_kind in 0..3 {
                let mut calls = 0;
                let result = stress_test_with(&request(), |building| {
                    calls += 1;
                    let mut run = synthetic_run(building, completed(100));
                    if (calls == 1) == incomplete_baseline_frame {
                        match missing_kind {
                            0 => run.frames.clear(),
                            1 => {
                                run.frames[0].agents.pop();
                            }
                            _ => run.frames[0].step = 1,
                        }
                    }
                    Ok(run)
                })
                .unwrap();
                assert!(result.scenarios.iter().all(|scenario| {
                    scenario.description.contains("fairness UNVERIFIED")
                        && scenario.description.contains("complete step-zero frame")
                }));
            }
        }
    }

    #[test]
    fn fairness_is_reported_per_comparison() {
        let mut calls = 0;
        let result = stress_test_with(&request(), |building| {
            calls += 1;
            let mut run = synthetic_run(building, completed(100));
            if calls == 2 {
                run.frames.clear();
            }
            Ok(run)
        })
        .unwrap();
        assert!(
            result.scenarios[0]
                .description
                .contains("fairness UNVERIFIED")
        );
        assert!(
            result.scenarios[1..]
                .iter()
                .all(|scenario| scenario.description.contains("fairness verified"))
        );
    }

    #[test]
    fn invalid_simulation_metrics_and_duplicate_initial_ids_are_rejected() {
        for invalid_kind in 0..4 {
            for invalid_baseline in [true, false] {
                let mut calls = 0;
                let result = stress_test_with(&request(), |building| {
                    calls += 1;
                    let mut run = synthetic_run(building, completed(100));
                    if (calls == 1) == invalid_baseline {
                        match invalid_kind {
                            0 => run.metrics.clearance_steps = None,
                            1 => {
                                run.metrics = SimulationMetrics {
                                    clearance_steps: Some(0),
                                    ..unfinished(1, 0, SimulationStatus::Timeout)
                                }
                            }
                            2 => run.frames[0].agents[1].id = run.frames[0].agents[0].id,
                            _ => run.metrics.trapped = 1,
                        }
                    }
                    Ok(run)
                });
                assert!(invalid_message(result).contains("invalid simulation output"));
                assert_eq!(calls, if invalid_baseline { 1 } else { 2 });
            }
        }
    }

    #[test]
    fn simulation_output_must_match_the_requested_experiment() {
        for invalid_kind in 0..6 {
            let mut calls = 0;
            let result = stress_test_with(&request(), |building| {
                calls += 1;
                let mut run = synthetic_run(building, completed(100));
                if calls == 2 {
                    match invalid_kind {
                        0 => {
                            run.metrics.total_population = 5;
                            run.metrics.evacuated = 5;
                        }
                        1 => run.width += 1.0,
                        2 => run.height += 1.0,
                        3 => run.time_step_seconds /= 2.0,
                        4 => run.metrics.clearance_steps = Some(building.max_steps + 1),
                        _ => run.frames[0].step = building.max_steps + 1,
                    }
                }
                Ok(run)
            });
            assert!(invalid_message(result).contains("does not match the requested"));
            assert_eq!(calls, 2);
        }
    }

    #[test]
    fn simulation_errors_propagate_without_partial_results_or_further_runs() {
        for failing_call in [1, 3] {
            for not_implemented in [true, false] {
                let request = request();
                let original = to_value(&request).unwrap();
                let mut calls = 0;
                let result = stress_test_with(&request, |building| {
                    calls += 1;
                    if calls == failing_call {
                        if not_implemented {
                            Err(SimulationError::NotImplemented)
                        } else {
                            Err(SimulationError::InvalidScenario(
                                "synthetic placement failure".into(),
                            ))
                        }
                    } else {
                        Ok(synthetic_run(building, completed(100)))
                    }
                });
                if not_implemented {
                    assert!(matches!(result, Err(SimulationError::NotImplemented)));
                } else {
                    assert_eq!(invalid_message(result), "synthetic placement failure");
                }
                assert_eq!(calls, failing_call);
                assert_eq!(to_value(&request).unwrap(), original);
            }
        }
    }

    #[test]
    fn production_entry_point_matches_the_real_simulator_and_validates_requests() {
        let request = request();
        let baseline = crate::simulation::simulate(&request.building).unwrap();
        baseline.validate().unwrap();
        let result = stress_test(&request).unwrap();
        assert_eq!(
            to_value(result.baseline).unwrap(),
            to_value(baseline.metrics).unwrap()
        );
        let mut invalid = request;
        invalid.config.max_scenarios = 0;
        assert!(matches!(
            stress_test(&invalid),
            Err(SimulationError::InvalidScenario(_))
        ));
    }
}

// Real-engine regression fixtures are shared only with optimization's integration tests.
#[cfg(test)]
pub(crate) mod real_integration {
    use super::*;
    use crate::models::{Point, SimulationStatus};
    use serde_json::{json, to_value};

    #[test]
    fn cancellation_interrupts_a_real_stress_evaluation_without_partial_success() {
        let request = stress_request(room());
        let control = std::sync::Arc::new(crate::simulation::ComputationControl::default());
        let mut calls = 0;
        let result = control.run(|| {
            stress_test_with(&request, |building| {
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

    /// A closed 12 x 8 m room, two north-wall exits, and one fixed spawn point.
    /// Buildings are test inputs; all metrics/frames come from the actual simulator.
    pub(crate) fn room() -> BuildingScenario {
        serde_json::from_value(json!({
            "width": 12.0, "height": 8.0,
            "walls": [
                {"id": "north", "start": {"x": 0.0, "y": 0.0}, "end": {"x": 12.0, "y": 0.0}, "thickness": 0.2},
                {"id": "south", "start": {"x": 0.0, "y": 8.0}, "end": {"x": 12.0, "y": 8.0}, "thickness": 0.2},
                {"id": "west", "start": {"x": 0.0, "y": 0.0}, "end": {"x": 0.0, "y": 8.0}, "thickness": 0.2},
                {"id": "east", "start": {"x": 12.0, "y": 0.0}, "end": {"x": 12.0, "y": 8.0}, "thickness": 0.2}
            ],
            "doors": [],
            "exits": [
                {"id": "left", "wall_id": "north", "offset": 1.0, "width": 1.2},
                {"id": "right", "wall_id": "north", "offset": 9.0, "width": 1.2}
            ],
            "spawn_zones": [{"id": "left-occupant", "x": 1.0, "y": 4.0, "width": 0.4, "height": 0.4, "count": 1}],
            "blocked_exit_ids": [], "obstructions": [], "agent_radius": 0.2,
            "time_step_seconds": 0.2, "seed": 42, "max_steps": 500
        })).unwrap()
    }

    pub(crate) fn split_room() -> BuildingScenario {
        let mut building = room();
        building.walls.push(crate::models::Wall {
            id: "divider".into(),
            name: None,
            start: Point { x: 6.0, y: 0.0 },
            end: Point { x: 6.0, y: 8.0 },
            thickness: 0.2,
        });
        building.spawn_zones.push(crate::models::SpawnZone {
            id: "right-occupant".into(),
            name: None,
            x: 8.0,
            y: 4.0,
            width: 0.4,
            height: 0.4,
            count: 1,
        });
        building
    }

    // Independent segment-distance assertions check actual per-tick swept paths,
    // including the final move to an exit (evacuated agents disappear from frames).
    // These do not call or change Connor's private collision helpers.
    fn point_distance(p: Point, a: Point, b: Point) -> f64 {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let square = dx * dx + dy * dy;
        let t = if square == 0.0 {
            0.0
        } else {
            (((p.x - a.x) * dx + (p.y - a.y) * dy) / square).clamp(0.0, 1.0)
        };
        (p.x - a.x - t * dx).hypot(p.y - a.y - t * dy)
    }

    fn segment_distance(a: Point, b: Point, c: Point, d: Point) -> f64 {
        let cross =
            |p: Point, q: Point, r: Point| (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
        if cross(a, b, c) * cross(a, b, d) <= 0.0
            && cross(c, d, a) * cross(c, d, b) <= 0.0
            && a.x.min(b.x) <= c.x.max(d.x)
            && c.x.min(d.x) <= a.x.max(b.x)
            && a.y.min(b.y) <= c.y.max(d.y)
            && c.y.min(d.y) <= a.y.max(b.y)
        {
            return 0.0;
        }
        point_distance(a, c, d)
            .min(point_distance(b, c, d))
            .min(point_distance(c, a, b))
            .min(point_distance(d, a, b))
    }

    fn assert_clear_segment(building: &BuildingScenario, from: Point, to: Point) {
        for wall in &building.walls {
            let mut gaps: Vec<_> = building
                .doors
                .iter()
                .chain(
                    building
                        .exits
                        .iter()
                        .filter(|exit| !building.blocked_exit_ids.contains(&exit.id)),
                )
                .filter(|opening| opening.wall_id == wall.id)
                .collect();
            gaps.sort_by(|a, b| a.offset.total_cmp(&b.offset));
            let at = |offset: f64| Point {
                x: wall.start.x + (wall.end.x - wall.start.x) * offset / wall.length(),
                y: wall.start.y + (wall.end.y - wall.start.y) * offset / wall.length(),
            };
            let mut cursor = 0.0;
            for (start, end) in gaps
                .iter()
                .map(|opening| (opening.offset, opening.offset + opening.width))
                .chain(std::iter::once((wall.length(), wall.length())))
            {
                if start > cursor {
                    // Check the rounded solid first, then independently verify its
                    // rectangular body in wall-local coordinates.
                    assert!(
                        segment_distance(from, to, at(cursor), at(start)) + 1e-7
                            >= building.agent_radius + wall.thickness / 2.0,
                        "swept path {from:?} -> {to:?} crosses rounded wall '{}'",
                        wall.id
                    );
                    let origin = at(cursor);
                    let dx = (wall.end.x - wall.start.x) / wall.length();
                    let dy = (wall.end.y - wall.start.y) / wall.length();
                    let local = |point: Point| Point {
                        x: (point.x - origin.x) * dx + (point.y - origin.y) * dy,
                        y: -(point.x - origin.x) * dy + (point.y - origin.y) * dx,
                    };
                    assert_rectangle_clear(
                        local(from),
                        local(to),
                        (0.0, -wall.thickness / 2.0, start - cursor, wall.thickness),
                        building.agent_radius,
                        &wall.id,
                    );
                }
                cursor = end;
            }
        }
        for obstruction in &building.obstructions {
            assert_rectangle_clear(
                from,
                to,
                (
                    obstruction.x,
                    obstruction.y,
                    obstruction.width,
                    obstruction.height,
                ),
                building.agent_radius,
                &obstruction.id,
            );
        }
    }

    fn assert_rectangle_clear(
        from: Point,
        to: Point,
        bounds: (f64, f64, f64, f64),
        radius: f64,
        label: &str,
    ) {
        let (left, top, width, height) = bounds;
        let right = left + width;
        let bottom = top + height;
        let inside = |p: Point| p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
        assert!(
            !inside(from) && !inside(to),
            "agent entered solid '{label}'"
        );
        let corners = [
            Point { x: left, y: top },
            Point { x: right, y: top },
            Point {
                x: right,
                y: bottom,
            },
            Point { x: left, y: bottom },
        ];
        for index in 0..4 {
            assert!(
                segment_distance(from, to, corners[index], corners[(index + 1) % 4]) + 1e-7
                    >= radius,
                "swept path crosses solid '{label}'"
            );
        }
    }

    pub(crate) fn simulate_checked(building: &BuildingScenario) -> SimulationResult {
        building.validate().unwrap();
        let run = crate::simulation::simulate(building).unwrap();
        run.validate().unwrap();
        assert_eq!(
            run.metrics.total_population,
            building
                .spawn_zones
                .iter()
                .map(|zone| zone.count)
                .sum::<u32>()
        );
        let initial = initial_positions(&run).expect("real engine must supply complete step zero");
        let analytics = run.analytics.as_ref().expect("real per-agent analytics");
        for frame in &run.frames {
            for agent in &frame.agents {
                assert!(
                    initial.contains_key(&agent.id),
                    "agent IDs must remain stable"
                );
                let p = Point {
                    x: agent.x,
                    y: agent.y,
                };
                assert_clear_segment(building, p, p);
            }
        }
        for pair in run.frames.windows(2) {
            // Small fixtures retain every tick, so segments are actual accepted moves.
            assert_eq!(pair[1].step, pair[0].step + 1);
            for agent in &pair[0].agents {
                let from = Point {
                    x: agent.x,
                    y: agent.y,
                };
                let to = if let Some(next) = pair[1].agents.iter().find(|next| next.id == agent.id)
                {
                    Point {
                        x: next.x,
                        y: next.y,
                    }
                } else {
                    let stat = analytics
                        .agents
                        .iter()
                        .find(|stat| stat.id == agent.id)
                        .unwrap();
                    assert_eq!(stat.evacuation_step, Some(pair[1].step));
                    let exit = building
                        .exits
                        .iter()
                        .find(|exit| Some(&exit.id) == stat.exit_id.as_ref())
                        .unwrap();
                    assert!(!building.blocked_exit_ids.contains(&exit.id));
                    // Actual final movement is audited inside the simulation
                    // test build; arrivals can occur anywhere across the exit.
                    continue;
                };
                assert!(
                    (to.x - from.x).hypot(to.y - from.y) <= 1.3 * building.time_step_seconds + 1e-7
                );
                assert_clear_segment(building, from, to);
            }
        }
        run
    }

    fn audit(request: &StressTestRequest) -> StressTestResult {
        let original = to_value(request).unwrap();
        let baseline = simulate_checked(&request.building);
        let result = stress_test(request).unwrap();
        assert_eq!(
            to_value(&result.baseline).unwrap(),
            to_value(&baseline.metrics).unwrap()
        );
        assert!(result.scenarios.len() <= request.config.max_scenarios as usize);
        eprintln!("real stress baseline: {:?}", baseline.metrics);
        for scenario in &result.scenarios {
            assert_eq!(
                scenario.modifications.blocked_exit_ids.len()
                    + scenario.modifications.added_obstructions.len(),
                1
            );
            let mut modified = request.building.clone();
            modified
                .blocked_exit_ids
                .extend(scenario.modifications.blocked_exit_ids.iter().cloned());
            modified
                .obstructions
                .extend(scenario.modifications.added_obstructions.iter().cloned());
            let run = simulate_checked(&modified);
            assert_eq!(initial_positions(&baseline), initial_positions(&run));
            assert_eq!(
                to_value(&scenario.metrics).unwrap(),
                to_value(&run.metrics).unwrap()
            );
            assert!(scenario.description.contains("fairness verified"));
            assert_eq!(
                to_value(&scenario.severity).unwrap(),
                to_value(severity(&baseline.metrics, &run.metrics)).unwrap()
            );
            let worse = result
                .scenarios
                .iter()
                .filter(|other| other.metrics.compare_severity(&scenario.metrics).is_gt())
                .count();
            assert_eq!(scenario.rank, worse as u32 + 1);
            eprintln!(
                "real stress {}: {:?}, severity={:?}, rank={}",
                scenario.scenario_id, scenario.metrics, scenario.severity, scenario.rank
            );
        }
        assert!(
            result
                .scenarios
                .windows(2)
                .all(|pair| !pair[0].metrics.compare_severity(&pair[1].metrics).is_lt())
        );
        assert_eq!(to_value(request).unwrap(), original);
        result
    }

    fn stress_request(building: BuildingScenario) -> StressTestRequest {
        StressTestRequest {
            building,
            config: crate::models::StressTestConfig {
                max_scenarios: 10,
                block_each_exit: true,
                obstruction_candidates: vec![],
            },
        }
    }

    #[test]
    fn real_two_exit_room_has_distinct_closure_costs_and_repeatable_fairness() {
        let request = stress_request(room());
        let result = audit(&request);
        assert_eq!(result.baseline.status, SimulationStatus::Completed);
        assert_eq!(result.scenarios.len(), 2);
        let left = result
            .scenarios
            .iter()
            .find(|scenario| scenario.modifications.blocked_exit_ids == ["left"])
            .unwrap();
        let right = result
            .scenarios
            .iter()
            .find(|scenario| scenario.modifications.blocked_exit_ids == ["right"])
            .unwrap();
        assert_eq!(left.metrics.status, SimulationStatus::Completed);
        assert!(left.metrics.compare_severity(&result.baseline).is_gt());
        assert!(matches!(left.severity, Severity::High));
        assert!(matches!(right.severity, Severity::Low));
        assert_eq!(
            to_value(&result).unwrap(),
            to_value(stress_test(&request).unwrap()).unwrap()
        );
        let first = simulate_checked(&request.building);
        let second = simulate_checked(&request.building);
        assert_eq!(to_value(first).unwrap(), to_value(second).unwrap());
    }

    #[test]
    fn real_sealed_rooms_leave_one_occupant_without_a_route_when_its_exit_closes() {
        let request = stress_request(split_room());
        let result = audit(&request);
        assert_eq!(result.baseline.status, SimulationStatus::Completed);
        assert_eq!(result.baseline.evacuated, 2);
        for scenario in &result.scenarios {
            assert_eq!(scenario.metrics.status, SimulationStatus::Incomplete);
            assert_eq!(
                (
                    scenario.metrics.evacuated,
                    scenario.metrics.remaining,
                    scenario.metrics.trapped
                ),
                (1, 1, 0)
            );
            assert!(scenario.metrics.clearance_steps.is_none());
            assert!(matches!(scenario.severity, Severity::Critical));
            assert_eq!(scenario.rank, 1);
            let mut modified = request.building.clone();
            modified.blocked_exit_ids = scenario.modifications.blocked_exit_ids.clone();
            let run = simulate_checked(&modified);
            assert_eq!(
                run.analytics
                    .unwrap()
                    .agents
                    .iter()
                    .filter(|agent| !agent.route_found)
                    .count(),
                1
            );
            for frame in run.frames {
                for agent in frame.agents {
                    assert!(if agent.id == 0 {
                        agent.x < 6.0
                    } else {
                        agent.x > 6.0
                    });
                }
            }
        }
    }

    #[test]
    fn real_single_exit_closure_reports_trapped_population_and_null_clearance() {
        let mut building = room();
        building.exits.truncate(1);
        let result = audit(&stress_request(building));
        let metrics = &result.scenarios[0].metrics;
        assert_eq!(metrics.status, SimulationStatus::Incomplete);
        assert_eq!(
            (metrics.evacuated, metrics.remaining, metrics.trapped),
            (0, 1, 1)
        );
        assert_eq!(
            to_value(metrics).unwrap()["clearance_steps"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn real_forced_exit_closures_cannot_reopen_or_receive_false_low_severity() {
        for reopen_step in [0, 10] {
            let mut building = room();
            building.exits.truncate(1);
            building
                .opening_events
                .push(crate::models::OpeningStateChange {
                    step: reopen_step,
                    opening_id: "left".into(),
                    blocked: false,
                });
            let request = stress_request(building);
            let original = to_value(&request).unwrap();
            let baseline = crate::simulation::simulate(&request.building).unwrap();
            assert_eq!(baseline.metrics.status, SimulationStatus::Completed);
            let mut calls = 0;
            let result = stress_test_with(&request, |scenario| {
                calls += 1;
                let run = crate::simulation::simulate(scenario)?;
                assert_eq!(initial_positions(&run), initial_positions(&baseline));
                if !scenario.blocked_exit_ids.is_empty() {
                    assert!(run.frames.iter().all(|frame| {
                        frame
                            .blocked_opening_ids
                            .as_ref()
                            .is_some_and(|ids| ids.iter().any(|id| id == "left"))
                    }));
                }
                Ok(run)
            })
            .unwrap();
            assert_eq!(calls, 2);
            assert_eq!(
                to_value(&result.baseline).unwrap(),
                to_value(&baseline.metrics).unwrap()
            );
            let scenario = &result.scenarios[0];
            assert_eq!(scenario.metrics.status, SimulationStatus::Incomplete);
            assert_eq!(
                (
                    scenario.metrics.evacuated,
                    scenario.metrics.remaining,
                    scenario.metrics.trapped
                ),
                (0, 1, 1)
            );
            assert!(scenario.metrics.clearance_steps.is_none());
            assert!(matches!(scenario.severity, Severity::Critical));
            assert!(scenario.description.contains("fairness verified"));
            assert_eq!(to_value(&request).unwrap(), original);
            assert_eq!(
                to_value(&result).unwrap(),
                to_value(stress_test(&request).unwrap()).unwrap()
            );
        }
    }

    #[test]
    fn real_obstructions_cause_a_detour_or_disconnect_the_only_exit() {
        let mut building = room();
        building.exits.truncate(1);
        let mut request = stress_request(building);
        request.config.block_each_exit = false;
        request.config.obstruction_candidates = vec![
            crate::models::Obstruction {
                id: "detour".into(),
                name: None,
                x: 0.5,
                y: 2.0,
                width: 2.0,
                height: 1.0,
            },
            crate::models::Obstruction {
                id: "barrier".into(),
                name: None,
                x: 0.0,
                y: 2.0,
                width: 12.0,
                height: 1.0,
            },
        ];
        let result = audit(&request);
        let detour = result
            .scenarios
            .iter()
            .find(|scenario| scenario.scenario_id == "add-obstruction:detour")
            .unwrap();
        assert_eq!(detour.metrics.status, SimulationStatus::Completed);
        assert!(detour.metrics.clearance_steps > result.baseline.clearance_steps);
        let barrier = result
            .scenarios
            .iter()
            .find(|scenario| scenario.scenario_id == "add-obstruction:barrier")
            .unwrap();
        assert_eq!(barrier.metrics.status, SimulationStatus::Incomplete);
        assert_eq!((barrier.metrics.remaining, barrier.metrics.trapped), (1, 0));
        assert!(barrier.metrics.clearance_steps.is_none());
    }

    #[test]
    fn real_timeout_and_shared_budget_use_actual_simulation_calls() {
        let mut building = room();
        building.max_steps = 1;
        let mut request = stress_request(building);
        request.config.max_scenarios = 1;
        let result = audit(&request);
        assert_eq!(result.baseline.status, SimulationStatus::Timeout);
        assert_eq!(result.baseline.remaining, 1);
        assert!(result.baseline.clearance_steps.is_none());
        let mut calls = 0;
        let counted = stress_test_with(&request, |building| {
            calls += 1;
            crate::simulation::simulate(building)
        })
        .unwrap();
        assert_eq!(calls, 2); // Baseline plus one modified scenario.
        assert_eq!(counted.scenarios.len(), 1);
        assert_eq!(
            counted.scenarios[0].metrics.status,
            SimulationStatus::Timeout
        );
        assert_eq!(to_value(counted).unwrap(), to_value(result).unwrap());
    }

    #[test]
    fn real_diagonal_wall_exit_and_closure_respect_swept_geometry() {
        let mut building = room();
        building.walls.truncate(1);
        building.walls[0].end.y = 8.0;
        building.exits.truncate(1);
        building.exits[0].offset = 5.0;
        building.spawn_zones[0].x = 8.0;
        building.spawn_zones[0].y = 1.0;
        let result = audit(&stress_request(building));
        assert_eq!(result.baseline.status, SimulationStatus::Completed);
        assert_eq!(result.scenarios[0].metrics.trapped, 1);
    }

    #[test]
    fn real_checked_in_example_runs_baseline_and_both_exit_closures() {
        let building: BuildingScenario =
            serde_json::from_str(include_str!("../../../shared/examples/building.json")).unwrap();
        let result = audit(&stress_request(building));
        assert_eq!(result.baseline.total_population, 34);
        assert_eq!(result.scenarios.len(), 2);
    }

    #[test]
    fn real_spawn_failures_propagate_without_fabricated_results() {
        let mut building = room();
        building.spawn_zones[0].height = 0.8;
        building.spawn_zones[0].count = 2; // Area check passes; random packing cannot fit both discs.
        building.validate().unwrap();
        let expected = crate::simulation::simulate(&building)
            .unwrap_err()
            .to_string();
        assert!(expected.contains("could not place occupant"));
        assert_eq!(
            stress_test(&stress_request(building))
                .unwrap_err()
                .to_string(),
            expected
        );
    }
}
