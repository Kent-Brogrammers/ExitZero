use crate::models::{AgentStatistics, SimulationAnalytics};

/// Summaries are calculated from full-resolution simulation counters, even when
/// animation frames are sampled. Remaining occupants are excluded from median.
pub(super) fn summarize(
    agents: Vec<AgentStatistics>,
    simulated_seconds: f64,
) -> SimulationAnalytics {
    let mut times: Vec<f64> = agents
        .iter()
        .filter_map(|agent| agent.evacuation_seconds)
        .collect();
    times.sort_by(f64::total_cmp);
    let median_evacuation_seconds = if times.is_empty() {
        None
    } else {
        let middle = times.len() / 2;
        Some(if times.len() % 2 == 0 {
            (times[middle - 1] + times[middle]) / 2.0
        } else {
            times[middle]
        })
    };
    SimulationAnalytics {
        simulated_seconds,
        median_evacuation_seconds,
        total_distance_metres: agents.iter().map(|agent| agent.distance_metres).sum(),
        total_waiting_seconds: agents.iter().map(|agent| agent.waiting_seconds).sum(),
        agents,
    }
}
