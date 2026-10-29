//! Integrate crowd delay at physics frequency, independently of output sampling.
use super::{agent::Agent, geometry::Geometry, math};
use crate::models::{BuildingScenario, CongestionSample, Point};
use std::collections::BTreeMap;

type Samples = BTreeMap<(u32, u32), CongestionSample>;

#[derive(Default)]
pub(super) struct Heatmap {
    total: Samples,
    saved: Samples,
    live: Samples,
}

impl Heatmap {
    /// Delay is the fraction of a normal walking tick lost while another active
    /// occupant is within the local neighborhood and on the same visible side
    /// of static geometry. This measures coincident crowding and slowdown; it
    /// does not claim that crowding caused every lost second.
    pub(super) fn record(
        &mut self,
        scenario: &BuildingScenario,
        before: &[Point],
        agents: &[Agent],
        inactive: &[bool],
        geometry: &Geometry<'_>,
        walking_speed: f64,
    ) {
        let radius = 1.0_f64.max(4.0 * scenario.agent_radius);
        let mut neighbors: BTreeMap<(i32, i32), Vec<usize>> = BTreeMap::new();
        let cell = |point: Point| {
            (
                (point.x / radius).floor() as i32,
                (point.y / radius).floor() as i32,
            )
        };
        for (i, agent) in agents.iter().enumerate().filter(|(i, _)| !inactive[*i]) {
            neighbors.entry(cell(agent.position)).or_default().push(i);
        }
        // Aggregation is for display only and never changes navigation.
        let bucket = scenario.width.max(scenario.height) / 128.0;
        for (i, agent) in agents.iter().enumerate().filter(|(i, _)| !inactive[*i]) {
            let delay = scenario.time_step_seconds
                * (1.0
                    - math::distance_to_point(before[i], agent.position)
                        / (walking_speed * scenario.time_step_seconds))
                    .clamp(0.0, 1.0);
            // Avoid a false free-flow signal from floating-point roundoff.
            if delay <= scenario.time_step_seconds * 1e-9 {
                continue;
            }
            let (col, row) = cell(agent.position);
            let crowded = (-1..=1).any(|dy| {
                (-1..=1).any(|dx| {
                    neighbors.get(&(col + dx, row + dy)).is_some_and(|indices| {
                        indices.iter().any(|&j| {
                            j != i
                                && math::distance_to_point(agent.position, agents[j].position)
                                    <= radius
                                && geometry.has_line_of_sight(agent.position, agents[j].position)
                        })
                    })
                })
            });
            if !crowded {
                continue;
            }
            let key = (
                (agent.position.x / bucket).floor() as u32,
                (agent.position.y / bucket).floor() as u32,
            );
            // Keep one observed representative for the lifetime of each bucket.
            // Otherwise output intervals can land in different display bins
            // from the whole-run map when the frontend rebins these positions.
            let total = self.total.entry(key).or_insert(CongestionSample {
                x: agent.position.x,
                y: agent.position.y,
                crowd_delay_seconds: 0.0,
            });
            total.crowd_delay_seconds += delay;
            for samples in [&mut self.saved, &mut self.live] {
                samples
                    .entry(key)
                    .or_insert(CongestionSample {
                        x: total.x,
                        y: total.y,
                        crowd_delay_seconds: 0.0,
                    })
                    .crowd_delay_seconds += delay;
            }
        }
    }

    pub(super) fn saved(&mut self) -> Option<Vec<CongestionSample>> {
        Some(std::mem::take(&mut self.saved).into_values().collect())
    }

    pub(super) fn live(&mut self) -> Option<Vec<CongestionSample>> {
        Some(std::mem::take(&mut self.live).into_values().collect())
    }

    pub(super) fn total(self) -> Option<Vec<CongestionSample>> {
        Some(self.total.into_values().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Wall;

    fn scenario() -> BuildingScenario {
        let mut scenario: BuildingScenario =
            serde_json::from_str(include_str!("../../../shared/examples/building.json")).unwrap();
        scenario.width = 10.0;
        scenario.height = 10.0;
        scenario.agent_radius = 0.2;
        scenario.time_step_seconds = 0.1;
        scenario.walls.clear();
        scenario.doors.clear();
        scenario.exits.clear();
        scenario.windows.clear();
        scenario.obstructions.clear();
        scenario
    }

    fn people(xs: &[f64]) -> Vec<Agent> {
        xs.iter()
            .enumerate()
            .map(|(id, &x)| Agent::new(id as u32, Point { x, y: 2.0 }))
            .collect()
    }

    fn total(samples: Option<Vec<CongestionSample>>) -> f64 {
        samples
            .unwrap()
            .iter()
            .map(|sample| sample.crowd_delay_seconds)
            .sum()
    }

    #[test]
    fn crowd_delay_requires_simultaneous_people_and_slow_movement() {
        let scenario = scenario();
        let geometry = Geometry::new(&scenario);
        let mut map = Heatmap::default();
        let alone = people(&[2.0]);
        map.record(
            &scenario,
            &[alone[0].position],
            &alone,
            &[false],
            &geometry,
            1.3,
        );
        assert_eq!(total(map.saved()), 0.0);

        let moving = people(&[2.13, 2.73]);
        map.record(
            &scenario,
            &[Point { x: 2.0, y: 2.0 }, Point { x: 2.6, y: 2.0 }],
            &moving,
            &[false, false],
            &geometry,
            1.3,
        );
        assert_eq!(total(map.saved()), 0.0);

        let queued = people(&[2.0, 2.6]);
        let before: Vec<_> = queued.iter().map(|a| a.position).collect();
        map.record(&scenario, &before, &queued, &[false, false], &geometry, 1.3);
        assert!((total(map.saved()) - 0.2).abs() < 1e-10);
        // A departed occupant no longer makes the remaining person crowded.
        map.record(&scenario, &before, &queued, &[false, true], &geometry, 1.3);
        assert_eq!(total(map.saved()), 0.0);
    }

    #[test]
    fn population_duration_and_partial_slowdown_control_the_integral() {
        let mut scenario = scenario();
        let queued = people(&[2.0, 2.6, 3.2]);
        let before: Vec<_> = queued.iter().map(|a| a.position).collect();
        let mut map = Heatmap::default();
        for _ in 0..10 {
            map.record(
                &scenario,
                &before,
                &queued,
                &[false; 3],
                &Geometry::new(&scenario),
                1.3,
            );
        }
        assert!((total(map.total()) - 3.0).abs() < 1e-10);
        scenario.time_step_seconds = 1.0;
        let mut map = Heatmap::default();
        map.record(
            &scenario,
            &before,
            &queued,
            &[false; 3],
            &Geometry::new(&scenario),
            1.3,
        );
        assert!((total(map.saved()) - 3.0).abs() < 1e-10);
        // Saved-frame and live-stream buffers are independent; draining either
        // cannot lose samples from the other or the complete result.
        assert!((total(map.live()) - 3.0).abs() < 1e-10);
        assert_eq!(total(map.saved()), 0.0);
        assert!((total(map.total()) - 3.0).abs() < 1e-10);

        let half_speed = people(&[2.65, 3.25]);
        let mut map = Heatmap::default();
        map.record(
            &scenario,
            &before[..2],
            &half_speed,
            &[false; 2],
            &Geometry::new(&scenario),
            1.3,
        );
        assert!((total(map.total()) - 1.0).abs() < 1e-10);
    }

    #[test]
    fn a_wall_prevents_nearby_separate_rooms_from_counting_as_a_crowd() {
        let mut scenario = scenario();
        scenario.walls.push(Wall {
            id: "divider".into(),
            name: None,
            start: Point { x: 2.5, y: 0.0 },
            end: Point { x: 2.5, y: 10.0 },
            thickness: 0.2,
        });
        let queued = people(&[2.1, 2.9]);
        let before: Vec<_> = queued.iter().map(|a| a.position).collect();
        let mut map = Heatmap::default();
        map.record(
            &scenario,
            &before,
            &queued,
            &[false; 2],
            &Geometry::new(&scenario),
            1.3,
        );
        assert_eq!(total(map.total()), 0.0);
    }

    #[test]
    fn interval_samples_retain_the_whole_run_observed_representative() {
        let scenario = scenario();
        let geometry = Geometry::new(&scenario);
        let mut map = Heatmap::default();
        let initial = people(&[2.0, 2.6]);
        let before: Vec<_> = initial.iter().map(|a| a.position).collect();
        map.record(&scenario, &before, &initial, &[false; 2], &geometry, 1.3);
        let first_saved = map.saved().unwrap();
        map.live();
        let moved = people(&[2.01, 2.61]);
        let before: Vec<_> = moved.iter().map(|a| a.position).collect();
        map.record(&scenario, &before, &moved, &[false; 2], &geometry, 1.3);
        for interval in [map.saved().unwrap(), map.live().unwrap()] {
            assert_eq!(interval.len(), first_saved.len());
            for (sample, original) in interval.iter().zip(&first_saved) {
                assert_eq!((sample.x, sample.y), (original.x, original.y));
            }
        }
    }

    #[test]
    fn configured_walking_speed_does_not_make_slow_free_flow_congested() {
        let scenario = scenario();
        let geometry = Geometry::new(&scenario);
        let moving = people(&[2.07, 2.67]);
        let mut map = Heatmap::default();
        map.record(
            &scenario,
            &[Point { x: 2.0, y: 2.0 }, Point { x: 2.6, y: 2.0 }],
            &moving,
            &[false; 2],
            &geometry,
            0.7,
        );
        assert_eq!(total(map.total()), 0.0);
    }
}
